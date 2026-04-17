const { GoogleGenerativeAI } = require("@google/generative-ai");

const API_KEYS = [
  process.env.GOOGLE_AI_API_KEY,
  process.env.GOOGLE_AI_API_KEY_2
].filter(Boolean);

const GEMMA_PRIMARY = "gemma-4-31b-it";
const GEMMA_FALLBACK = "gemma-3-27b-it"; // TODO: retirer après le 30 avril 2026

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
 * Exécute une tâche Gemma avec Gemma 4 en primaire.
 * Bascule sur Gemma 3 uniquement en cas de 429 (rate limit).
 */
async function runGemmaWithFallback(buildTask, label) {
  console.log(`🤖 [GEMMA-4] ${label} — modèle: ${GEMMA_PRIMARY}`);

  try {
    const result = await runWithRetry((genAI) => {
      const model = genAI.getGenerativeModel({ model: GEMMA_PRIMARY });
      return buildTask(model);
    });
    console.log(`✅ [GEMMA-4] ${label} — succès`);
    return result;
  } catch (error) {
    const isRateLimit = error.message.includes('429')
      || error.message.toLowerCase().includes('quota')
      || error.message.toLowerCase().includes('rate limit');

    if (isRateLimit) {
      console.warn(`⚠️ [GEMMA FALLBACK] Rate limit sur Gemma 4 — bascule sur ${GEMMA_FALLBACK} pour: ${label}`);
      const result = await runWithRetry((genAI) => {
        const model = genAI.getGenerativeModel({ model: GEMMA_FALLBACK });
        return buildTask(model);
      });
      console.log(`✅ [GEMMA-3 FALLBACK] ${label} — succès`);
      return result;
    }

    console.error(`❌ [GEMMA-4] ${label} — erreur non-rate-limit: ${error.message}`);
    throw error;
  }
}

/**
 * Génère un embedding vectoriel
 */
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

/**
 * Classifie un article dans une catégorie WordPress
 */
async function classifyArticle(title, excerpt, categories) {
  if (!categories || categories.length === 0) return 1;

  const categoriesWithHierarchy = categories.map(cat => {
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

  try {
    return await runGemmaWithFallback(async (model) => {
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const id = parseInt(text.match(/\d+/)?.[0]);
      return isNaN(id) ? categories[0]?.id : id;
    }, label);
  } catch (error) {
    console.error('❌ Échec définitif classification:', error.message);
    return categories[0]?.id;
  }
}

/**
 * Filtre un lot d'articles selon leur pertinence par rapport au Persona
 */
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
    return await runGemmaWithFallback(async (model) => {
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim();
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBracket = text.indexOf('[');
      const lastBracket = text.lastIndexOf(']');
      if (firstBracket !== -1 && lastBracket !== -1) {
        return JSON.parse(text.substring(firstBracket, lastBracket + 1));
      }
      return [];
    }, label);
  } catch (error) {
    console.error('❌ Échec définitif filtrage batch:', error.message);
    return [];
  }
}

module.exports = { getEmbedding, classifyArticle, filterBestArticlesBatch };
