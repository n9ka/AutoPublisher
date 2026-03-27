const axios = require('axios');

/**
 * Effectue une recherche web approfondie via Perplexity Sonar
 * @param {string} keyword - Le mot-clé SEO cible
 */
async function researchWithPerplexity(keyword) {
  if (!process.env.PERPLEXITY_API_KEY) {
    console.warn('  ⚠️ PERPLEXITY_API_KEY manquante.');
    return "";
  }

  try {
    console.log(`  🌐 Recherche Perplexity pour : "${keyword}"...`);
    
    const response = await axios.post('https://api.perplexity.ai/chat/completions', {
      model: "sonar", // Modèle standard plus économique
      messages: [
        {
          role: "system",
          content: "Tu es un assistant de recherche expert. Fournis une synthèse factuelle, détaillée et actualisée (2024-2025) sur le sujet demandé. Inclus des chiffres, des statistiques et des points clés. Ne rédige pas d'article, fournis uniquement la matière brute pour un rédacteur."
        },
        {
          role: "user",
          content: `Fais une recherche complète sur le sujet suivant : ${keyword}`
        }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return response.data.choices[0].message.content;

  } catch (error) {
    console.error('  ❌ Erreur Perplexity:', error.response?.data || error.message);
    return "";
  }
}

module.exports = { researchWithPerplexity };