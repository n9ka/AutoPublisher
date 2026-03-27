const { GoogleGenerativeAI } = require("@google/generative-ai");

// Liste des clés pour la rotation en cas d'échec
const API_KEYS = [
  process.env.GOOGLE_AI_API_KEY,
  process.env.GOOGLE_AI_API_KEY_2
].filter(Boolean);

/**
 * Exécute une fonction IA avec retry et rotation de clé
 */
async function runWithRetry(task, maxRetries = 2) {
  let lastError;
  
  // On tente pour chaque clé disponible
  for (let keyIndex = 0; keyIndex < API_KEYS.length; keyIndex++) {
    const genAI = new GoogleGenerativeAI(API_KEYS[keyIndex]);
    
    // Pour chaque clé, on peut faire plusieurs tentatives (retry)
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await task(genAI);
      } catch (error) {
        lastError = error;
        const isTransient = error.message.includes('503') || error.message.includes('overloaded') || error.message.includes('429');
        
        if (isTransient) {
          console.warn(`⚠️ Tentative ${attempt + 1} échouée avec la clé ${keyIndex + 1} (Erreur transient). Retente...`);
          // Petite pause avant de retenter
          await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
          continue;
        }
        // Si c'est une erreur fatale (404, auth, etc.), on change de clé immédiatement
        break; 
      }
    }
    console.warn(`🔄 Changement de clé API (Clé ${keyIndex + 1} épuisée ou en erreur).`);
  }
  
  throw lastError;
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
 * Classifie un article
 */
async function classifyArticle(title, excerpt, categories) {
  if (!categories || categories.length === 0) return 1;

  // Reconstruire la hiérarchie pour l'IA (ex: "Parent > Enfant")
  const categoriesWithHierarchy = categories.map(cat => {
    let fullName = cat.name;
    let currentParentId = cat.parent;
    
    // On remonte d'un niveau pour le nom (suffisant pour le contexte)
    if (currentParentId && currentParentId !== 0) {
      const parent = categories.find(c => c.id === currentParentId);
      if (parent) {
        fullName = `${parent.name} > ${cat.name}`;
      }
    }
    return { id: cat.id, name: fullName };
  });

  const categoriesList = JSON.stringify(categoriesWithHierarchy);
  
  const prompt = `
  Tu es un expert WordPress. Choisis l'ID de la catégorie la plus pertinente pour cet article.
  TITRE: "${title}"
  RESUME: "${excerpt}"
  CATEGORIES DISPONIBLES: ${categoriesList}
  Réponds UNIQUEMENT avec l'ID numérique choisi.
  `;

  try {
    return await runWithRetry(async (genAI) => {
      const model = genAI.getGenerativeModel({ model: "gemma-3-27b-it" });
      const result = await model.generateContent(prompt);
      const text = result.response.text().trim();
      const id = parseInt(text.match(/\d+/)?.[0]);
      return isNaN(id) ? categories[0]?.id : id;
    });
  } catch (error) {
    console.error('❌ Échec définitif classification:', error.message);
    return categories[0]?.id;
  }
}

/**
 * Filtre un lot d'articles en fonction de leur pertinence ET du Persona.
 */
async function filterBestArticlesBatch(articles, persona, preferredKeywords = "") {
  if (!articles || articles.length === 0) return [];

  const articlesListTxt = articles.map((a, index) => 
    `ID ${index}: [TITRE] ${a.title} 
 [EXTRAIT] ${a.contentSnippet.substring(0, 300)}`
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

  try {
    return await runWithRetry(async (genAI) => {
      const model = genAI.getGenerativeModel({ model: "gemma-3-27b-it" });
      const result = await model.generateContent(prompt);
      let text = result.response.text().trim();
      
      text = text.replace(/```json/g, '').replace(/```/g, '').trim();
      const firstBracket = text.indexOf('[');
      const lastBracket = text.lastIndexOf(']');
      
      if (firstBracket !== -1 && lastBracket !== -1) {
        text = text.substring(firstBracket, lastBracket + 1);
        return JSON.parse(text);
      }
      return [];
    });
  } catch (error) {
    console.error('❌ Échec définitif filtrage batch:', error.message);
    return []; 
  }
}

module.exports = { getEmbedding, classifyArticle, filterBestArticlesBatch };

module.exports = { getEmbedding, classifyArticle, filterBestArticlesBatch };
