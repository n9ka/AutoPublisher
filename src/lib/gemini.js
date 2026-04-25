const { GoogleGenerativeAI } = require("@google/generative-ai");

let Cerebras, MistralSDK;
try { Cerebras = require('@cerebras/cerebras_cloud_sdk'); } catch (_) {}
try { MistralSDK = require('@mistralai/mistralai'); } catch (_) {}

// ── Google AI ────────────────────────────────────────────────────────────────

const API_KEYS = [
  process.env.GOOGLE_AI_API_KEY,
  process.env.GOOGLE_AI_API_KEY_2
].filter(Boolean);

const GEMMA_PRIMARY = "gemma-3-27b-it"; // Temporaire : quotas Gemma 4 épuisés, retour Gemma 3 jusqu'au 30/04/2026
const GEMMA_FALLBACK = "gemma-4-31b-it";

const CEREBRAS_MODEL = "qwen-3-235b-a22b-instruct-2507";
const MISTRAL_MODEL  = "mistral-small-latest";

// ── Stats tracking ───────────────────────────────────────────────────────────

const _stats = { calls: 0, gemma: 0, cerebras: 0, mistral: 0, errors: 0, fallbacks: [] };

function getStats() {
  return { ..._stats, fallbacks: [..._stats.fallbacks] };
}

function resetStats() {
  _stats.calls = 0;
  _stats.gemma = 0;
  _stats.cerebras = 0;
  _stats.mistral = 0;
  _stats.errors = 0;
  _stats.fallbacks = [];
}

// ── Gemma (Google AI) ────────────────────────────────────────────────────────

async function runWithRetry(task, maxRetries = 2) {
  let lastError;

  for (let keyIndex = 0; keyIndex < API_KEYS.length; keyIndex++) {
    const genAI = new GoogleGenerativeAI(API_KEYS[keyIndex]);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await task(genAI);
      } catch (error) {
        lastError = error;
        const isTransient = error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('429');

        if (isTransient) {
          console.warn(`⚠️ Tentative ${attempt + 1} échouée avec la clé ${keyIndex + 1} (erreur transient). Retente...`);
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
    console.warn(`🔄 Changement de clé API (clé ${keyIndex + 1} épuisée ou en erreur).`);
  }

  throw lastError;
}

/**
 * Exécute une tâche Gemma avec Gemma 3 en primaire.
 * Bascule sur Gemma 4 uniquement en cas de 429 (rate limit).
 */
async function runGemmaWithFallback(buildTask, label) {
  console.log(`🤖 [GEMMA-3] ${label} — modèle: ${GEMMA_PRIMARY}`);

  try {
    const result = await runWithRetry((genAI) => {
      const model = genAI.getGenerativeModel({ model: GEMMA_PRIMARY });
      return buildTask(model);
    });
    console.log(`✅ [GEMMA-3] ${label} — succès`);
    return result;
  } catch (error) {
    const isRateLimit = error.message.includes('429')
      || error.message.toLowerCase().includes('quota')
      || error.message.toLowerCase().includes('rate limit');

    if (isRateLimit) {
      console.warn(`⚠️ [GEMMA FALLBACK] Rate limit sur Gemma 3 — bascule sur ${GEMMA_FALLBACK} pour: ${label}`);
      const result = await runWithRetry((genAI) => {
        const model = genAI.getGenerativeModel({ model: GEMMA_FALLBACK });
        return buildTask(model);
      });
      console.log(`✅ [GEMMA-4 FALLBACK] ${label} — succès`);
      return result;
    }

    console.error(`❌ [GEMMA-3] ${label} — erreur non-rate-limit: ${error.message}`);
    throw error;
  }
}

// ── Cerebras ─────────────────────────────────────────────────────────────────

async function callCerebras(prompt, maxTokens, temperature) {
  if (!Cerebras) throw new Error('SDK Cerebras non installé');
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) throw new Error('CEREBRAS_API_KEY non définie');

  const client = new Cerebras({ apiKey });
  const completion = await client.chat.completions.create({
    messages: [{ role: 'user', content: prompt }],
    model: CEREBRAS_MODEL,
    max_completion_tokens: maxTokens,
    temperature,
    stream: false
  });
  return completion.choices[0].message.content.trim();
}

// ── Mistral ──────────────────────────────────────────────────────────────────

async function callMistral(prompt, maxTokens, temperature) {
  if (!MistralSDK) throw new Error('SDK Mistral non installé');
  const apiKey = process.env.MISTRAL_API_KEY;
  if (!apiKey) throw new Error('MISTRAL_API_KEY non définie');

  const client = new MistralSDK.Mistral({ apiKey });
  const result = await client.chat.complete({
    model: MISTRAL_MODEL,
    messages: [{ role: 'user', content: prompt }],
    maxTokens,
    temperature
  });
  return result.choices[0].message.content.trim();
}

// ── Multi-provider fallback ──────────────────────────────────────────────────

/**
 * Chaîne : Gemma 3 (→ Gemma 4 sur 429) → Cerebras → Mistral
 * parseResponse : fonction (text: string) => valeur métier
 */
async function runWithMultiProviderFallback(prompt, parseResponse, label, options = {}) {
  const { maxTokens = 64, temperature = 0.1 } = options;
  _stats.calls++;

  // 1. Cerebras
  try {
    const text = await callCerebras(prompt, maxTokens, temperature);
    _stats.cerebras++;
    console.log(`✅ [CEREBRAS] ${label} — succès`);
    return parseResponse(text);
  } catch (cerebrasErr) {
    const reason = cerebrasErr.message.substring(0, 120);
    _stats.fallbacks.push({ label, from: 'cerebras', reason });
    console.warn(`⚠️ [MULTI-FALLBACK] Cerebras échoué pour "${label}" → Mistral | ${reason}`);
  }

  // 2. Mistral
  try {
    const text = await callMistral(prompt, maxTokens, temperature);
    _stats.mistral++;
    console.log(`✅ [MISTRAL] ${label} — succès`);
    return parseResponse(text);
  } catch (mistralErr) {
    const reason = mistralErr.message.substring(0, 120);
    _stats.fallbacks.push({ label, from: 'mistral', reason });
    console.warn(`⚠️ [MULTI-FALLBACK] Mistral échoué pour "${label}" → Gemma | ${reason}`);
  }

  // 3. Gemma
  try {
    const text = await runGemmaWithFallback(async (model) => {
      const r = await model.generateContent(prompt);
      return r.response.text().trim();
    }, label);
    _stats.gemma++;
    return parseResponse(text);
  } catch (gemmaErr) {
    _stats.errors++;
    _stats.fallbacks.push({ label, from: 'gemma', reason: gemmaErr.message.substring(0, 120) });
    console.error(`❌ [TOUS PROVIDERS ÉCHOUÉS] ${label}`);
    throw gemmaErr;
  }
}

// ── Embedding (Google uniquement, pas de fallback alternatif) ────────────────

async function getEmbedding(text) {
  if (!text) return null;
  const cleanText = text.substring(0, 9000);

  try {
    return await runWithRetry(async (genAI) => {
      const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
      const result = await model.embedContent({
        content: { parts: [{ text: cleanText }] },
        outputDimensionality: 768
      });
      return result.embedding.values;
    });
  } catch (error) {
    console.error('❌ Échec définitif embedding:', error.message);
    return null;
  }
}

// ── Classify article ─────────────────────────────────────────────────────────

const GENERIC_CAT_RE = /actualit|divers|g[eé]n[eé]ral|news|autres|uncategor|non.?class/i;

async function classifyArticle(title, excerpt, categories) {
  if (!categories || categories.length === 0) return 1;

  const specificCats = categories.filter(c => c.id !== 1 && !GENERIC_CAT_RE.test(c.name));
  const fallbackCat  = categories.find(c => GENERIC_CAT_RE.test(c.name)) ?? categories[0];

  if (specificCats.length === 0) return fallbackCat.id;

  const categoriesWithHierarchy = specificCats.map(cat => {
    let fullName = cat.name;
    if (cat.parent && cat.parent !== 0) {
      const parent = categories.find(c => c.id === cat.parent);
      if (parent) fullName = `${parent.name} > ${cat.name}`;
    }
    return { id: cat.id, name: fullName };
  });

  const prompt = `
  Tu es un expert WordPress. Choisis l'ID de la catégorie la plus pertinente pour cet article.
  TITRE: "${title}"
  RESUME: "${excerpt}"
  CATEGORIES DISPONIBLES: ${JSON.stringify(categoriesWithHierarchy)}
  Réponds UNIQUEMENT avec l'ID numérique choisi.
  `;

  const label = `classifyArticle("${title.substring(0, 60)}")`;
  const validIds = new Set(specificCats.map(c => c.id));

  try {
    return await runWithMultiProviderFallback(prompt, (text) => {
      const id = parseInt(text.match(/\d+/)?.[0]);
      return (id && validIds.has(id)) ? id : fallbackCat.id;
    }, label, { maxTokens: 16 });
  } catch (error) {
    console.error('❌ Échec définitif classification:', error.message);
    return fallbackCat.id;
  }
}

// ── Filter best articles batch ───────────────────────────────────────────────

async function filterBestArticlesBatch(articles, persona, preferredKeywords = "") {
  if (!articles || articles.length === 0) return [];

  const articlesListTxt = articles.map((a, index) =>
    `ID ${index}: [TITRE] ${a.title}\n [EXTRAIT] ${a.contentSnippet.substring(0, 300)}`
  ).join('\n---\n');

  const prompt = `
  Tu es l'éditeur en chef d'un blog expert.

  TON PERSONA (C'est ton identité) :
  Nom: ${persona.name || 'Expert'}
  Expertise: ${persona.background || 'Généraliste'}
  Ton: ${persona.tone || 'pro'}

  PRÉFÉRENCES DE SUJETS :
  L'utilisateur a un intérêt particulier pour : ${preferredKeywords || "Tous les sujets de sa spécialité"}

  MISSION :
  Parmi la liste ci-dessous, sélectionne les articles les plus pertinents à traiter.

  RÈGLES DE SÉLECTION :
  1. Priorité absolue aux sujets liés aux PRÉFÉRENCES DE SUJETS.
  2. Accepte aussi tout sujet qui s'inscrit logiquement dans ton EXPERTISE, même s'il ne contient pas les mots-clés exacts.
  3. Rejette les faits divers sans rapport, le sport (sauf si c'est ta spécialité) et les potins de stars.
  4. Sélectionne UNIQUEMENT des sujets qui permettent une analyse de fond.

  LISTE DES ARTICLES :
  ${articlesListTxt}

  Réponds UNIQUEMENT avec un tableau JSON contenant les IDs des articles retenus.
  Exemple : [0, 3, 5]
  Si aucun n'est bon, réponds : []
  `;

  const label = `filterBestArticlesBatch(${articles.length} articles, persona="${persona.name || 'Expert'}")`;

  try {
    return await runWithMultiProviderFallback(prompt, (text) => {
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBracket = text.indexOf('[');
      const lastBracket = text.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket !== -1) {
        return JSON.parse(text.substring(firstBracket, lastBracket + 1));
      }
      return [];
    }, label, { maxTokens: 64 });
  } catch (error) {
    console.error('❌ Échec définitif filtrage batch:', error.message);
    return [];
  }
}

module.exports = { getEmbedding, classifyArticle, filterBestArticlesBatch, getStats, resetStats };
