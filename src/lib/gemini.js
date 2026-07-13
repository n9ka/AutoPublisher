const { GoogleGenerativeAI } = require("@google/generative-ai");

let Cerebras, MistralSDK;
try { Cerebras = require('@cerebras/cerebras_cloud_sdk'); } catch (_) {}
try { MistralSDK = require('@mistralai/mistralai'); } catch (_) {}

// ── Clés Google AI ───────────────────────────────────────────────────────────

const API_KEYS_PRIMARY  = [process.env.GOOGLE_AI_API_KEY].filter(Boolean);
const API_KEYS_FALLBACK = [process.env.GOOGLE_AI_API_KEY_2, process.env.GOOGLE_AI_API_KEY_3].filter(Boolean);
const API_KEYS_ALL      = [...API_KEYS_PRIMARY, ...API_KEYS_FALLBACK];

// ── Modèles ──────────────────────────────────────────────────────────────────

const GEMMA_MODEL      = "gemma-4-31b-it";
const MISTRAL_MODEL    = "mistral-small-latest";
const CEREBRAS_MODEL   = "llama3.1-8b";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "meta-llama/llama-4-scout:free";

// ── Stats tracking ───────────────────────────────────────────────────────────

const _stats = { calls: 0, gemma: 0, mistral: 0, openrouter: 0, cerebras: 0, errors: 0 };

function getStats() { return { ..._stats }; }

function resetStats() {
  _stats.calls = 0; _stats.gemma = 0; _stats.mistral = 0;
  _stats.openrouter = 0; _stats.cerebras = 0; _stats.errors = 0;
}

// ── Google AI (Gemma) ────────────────────────────────────────────────────────

async function runWithRetry(task, keys, maxRetries = 2) {
  if (!keys || keys.length === 0) throw new Error('Aucune clé Google AI disponible dans ce groupe');
  let lastError;

  for (let keyIndex = 0; keyIndex < keys.length; keyIndex++) {
    const genAI = new GoogleGenerativeAI(keys[keyIndex]);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await task(genAI);
      } catch (error) {
        lastError = error;
        const msg = error?.message ?? String(error);
        const isTransient = msg.includes('503') || msg.includes('overloaded') || msg.includes('429') ||
                            msg.includes('canceled') || msg.includes('cancelled') ||
                            msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('timeout');
        if (isTransient) {
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          continue;
        }
        break;
      }
    }
  }
  throw lastError ?? new Error('Toutes les clés Google AI ont échoué');
}

async function callGemma(keys, prompt) {
  return runWithRetry((genAI) => {
    const model = genAI.getGenerativeModel({ model: GEMMA_MODEL });
    return model.generateContent(prompt).then(r => r.response.text().trim());
  }, keys);
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

// ── OpenRouter ───────────────────────────────────────────────────────────────

async function callOpenRouter(prompt, maxTokens, temperature) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY non définie');

  const axios = require('axios');
  const response = await axios.post('https://openrouter.ai/api/v1/chat/completions', {
    model: OPENROUTER_MODEL,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature
  }, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://aspy.fr',
      'X-Title': 'Aspy'
    },
    timeout: 30000
  });

  const content = response.data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('OpenRouter: réponse vide');
  return content.trim();
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

// ── Multi-provider fallback ──────────────────────────────────────────────────
// Ordre : Gemma(KEY_3) → Mistral → OpenRouter → Cerebras → Gemma(KEY_1+KEY_2)

async function runWithMultiProviderFallback(prompt, parseResponse, label, options = {}) {
  const { maxTokens = 64, temperature = 0.1 } = options;
  _stats.calls++;

  const attempt = async (fn) => {
    try { return { ok: true, text: await fn() }; }
    catch (e) { return { ok: false, err: e?.message ?? String(e) }; }
  };

  // 1. Gemma KEY_3 (primaire)
  if (API_KEYS_PRIMARY.length > 0) {
    const r = await attempt(() => callGemma(API_KEYS_PRIMARY, prompt));
    if (r.ok) { _stats.gemma++; return parseResponse(r.text); }
  }

  // 2. Mistral
  const rm = await attempt(() => callMistral(prompt, maxTokens, temperature));
  if (rm.ok) { _stats.mistral++; console.log(`✅ [MISTRAL] ${label}`); return parseResponse(rm.text); }

  // 3. OpenRouter
  const ro = await attempt(() => callOpenRouter(prompt, maxTokens, temperature));
  if (ro.ok) { _stats.openrouter++; console.log(`✅ [OPENROUTER] ${label}`); return parseResponse(ro.text); }

  // 4. Cerebras
  const rc = await attempt(() => callCerebras(prompt, maxTokens, temperature));
  if (rc.ok) { _stats.cerebras++; console.log(`✅ [CEREBRAS] ${label}`); return parseResponse(rc.text); }

  // 5. Gemma KEY_1 + KEY_2 (dernier recours free tier)
  if (API_KEYS_FALLBACK.length > 0) {
    const rg = await attempt(() => callGemma(API_KEYS_FALLBACK, prompt));
    if (rg.ok) { _stats.gemma++; console.log(`✅ [GEMMA-FALLBACK] ${label}`); return parseResponse(rg.text); }
  }

  _stats.errors++;
  console.error(`❌ [TOUS PROVIDERS ÉCHOUÉS] ${label}`);
  throw new Error(`Tous les providers IA ont échoué : ${label}`);
}

// ── Embedding (Google uniquement) ────────────────────────────────────────────

async function getEmbedding(text) {
  if (!text) return null;
  if (API_KEYS_ALL.length === 0) {
    console.error('❌ Embedding impossible : aucune clé Google AI configurée');
    return null;
  }

  const cleanText = text.substring(0, 9000);
  try {
    return await runWithRetry(async (genAI) => {
      const model = genAI.getGenerativeModel({ model: "gemini-embedding-001" });
      const result = await model.embedContent({
        content: { parts: [{ text: cleanText }] },
        outputDimensionality: 768
      });
      return result.embedding.values;
    }, API_KEYS_ALL);
  } catch (error) {
    console.error('❌ Échec définitif embedding:', error?.message ?? String(error));
    return null;
  }
}

// ── Classify article ─────────────────────────────────────────────────────────

const GENERIC_CAT_RE = /actualit|divers|g[eé]n[eé]ral|news|autres|uncategor|non.?class/i;

async function classifyArticle(title, excerpt, categories) {
  if (!categories || categories.length === 0) return 1;

  const specificCats = categories.filter(c => c.id !== 1 && !GENERIC_CAT_RE.test(c.name));
  const fallbackCat  = categories.find(c => GENERIC_CAT_RE.test(c.name) || c.id === 1) ?? categories[0];

  if (specificCats.length === 0) return fallbackCat.id;

  const allCatsForPrompt = categories.map(cat => {
    let fullName = cat.name;
    if (cat.parent && cat.parent !== 0) {
      const parent = categories.find(c => c.id === cat.parent);
      if (parent) fullName = `${parent.name} > ${cat.name}`;
    }
    const isGeneric = cat.id === 1 || GENERIC_CAT_RE.test(cat.name);
    return { id: cat.id, name: fullName, ...(isGeneric && { dernier_recours: true }) };
  });

  const prompt = `
  Tu es un expert WordPress. Choisis l'ID de la catégorie la plus pertinente pour cet article.
  TITRE: "${title}"
  RESUME: "${excerpt}"
  CATEGORIES DISPONIBLES: ${JSON.stringify(allCatsForPrompt)}
  RÈGLE : Choisis toujours une catégorie thématique précise. N'utilise une catégorie marquée "dernier_recours" que si vraiment aucune autre ne correspond.
  Réponds UNIQUEMENT avec l'ID numérique choisi.
  `;

  const label = `classifyArticle("${title.substring(0, 60)}")`;
  const validIds = new Set(categories.map(c => c.id));

  try {
    return await runWithMultiProviderFallback(prompt, (text) => {
      const matches = (text.match(/\d+/g) || []).map(Number).filter(n => validIds.has(n));
      return matches[matches.length - 1] ?? fallbackCat.id;
    }, label, { maxTokens: 16 });
  } catch (error) {
    console.error('❌ Échec définitif classification:', error?.message ?? String(error));
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
      const match = text.match(/\[\s*(?:\d+(?:\s*,\s*\d+)*)?\s*\]/);
      if (match) return JSON.parse(match[0]);
      return [];
    }, label, { maxTokens: 64 });
  } catch (error) {
    console.error('❌ Échec définitif filtrage batch:', error?.message ?? String(error));
    return [];
  }
}

function parseJsonObject(text = '') {
  const cleaned = String(text)
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Produit un brief court avant la rédaction Trend Spy. Le mécanisme de
 * fallback est le même que le filtre éditorial afin de ne pas ajouter une
 * dépendance de modèle ni modifier le coût facturé à l'utilisateur.
 */
async function generateTrendBrief(prompt, trendTitle = '') {
  const label = `generateTrendBrief("${String(trendTitle).substring(0, 60)}")`;

  try {
    const brief = await runWithMultiProviderFallback(
      prompt,
      parseJsonObject,
      label,
      { maxTokens: 1800, temperature: 0.2 }
    );

    if (!brief || typeof brief !== 'object') {
      console.warn('  ⚠️ Brief Trend Spy invalide : rédaction sans brief stratégique.');
      return null;
    }
    return brief;
  } catch (error) {
    console.warn(`  ⚠️ Brief Trend Spy indisponible : ${error?.message ?? String(error)}`);
    return null;
  }
}

module.exports = {
  generateTrendBrief,
  getEmbedding,
  classifyArticle,
  filterBestArticlesBatch,
  getStats,
  resetStats,
};
