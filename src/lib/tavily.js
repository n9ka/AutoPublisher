const axios = require('axios');

/**
 * Effectue une recherche web via Tavily (IA Search)
 * Offre 1000 recherches gratuites/mois.
 */
async function researchWithTavily(query) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn('  ⚠️ TAVILY_API_KEY manquante.');
    return null;
  }

  try {
    console.log(`  🌐 Recherche Tavily pour : "${query}"...`);
    
    const response = await axios.post('https://api.tavily.com/search', {
      api_key: apiKey,
      query: query,
      search_depth: "advanced", // Plus précis pour le mode Expert
      include_answer: true,
      max_results: 5
    });

    const results = response.data.results || [];
    const answer = response.data.answer || "";

    const context = results.map((res, i) => {
      return `[Source ${i + 1}: ${res.url}]\nTITRE: ${res.title}\nCONTENU: ${res.content}\n`;
    }).join('\n---\n');

    return `SYNTHÈSE IA TAVILY: ${answer}\n\nSOURCES DÉTAILLÉES:\n${context}`;

  } catch (error) {
    console.error('  ❌ Erreur Tavily:', error.response?.data || error.message);
    return null;
  }
}

async function extractWithTavily(url) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) return null;

  try {
    console.log(`  🌐 Tavily Extract pour : ${url}...`);
    const response = await axios.post('https://api.tavily.com/extract', {
      api_key: apiKey,
      urls: [url],
    });
    const result = (response.data.results || [])[0];
    if (!result?.raw_content || result.raw_content.length < 200) return null;
    return result.raw_content;
  } catch (error) {
    console.error('  ❌ Erreur Tavily Extract:', error.response?.data || error.message);
    return null;
  }
}

module.exports = { researchWithTavily, extractWithTavily };
