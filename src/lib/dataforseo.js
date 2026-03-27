const axios = require('axios');

const login = process.env.DATAFORSEO_LOGIN;
const password = process.env.DATAFORSEO_PASSWORD;

const client = axios.create({
  baseURL: 'https://api.dataforseo.com/v3',
  auth: { username: login, password: password },
  headers: { 'Content-Type': 'application/json' }
});

/**
 * Récupère des suggestions pour une liste d'axes (SANS FALLBACK pour économiser)
 */
async function getBulkKeywordSuggestions(seeds, locationCode = 2250, languageCode = 'fr', limit = 200) {
  let allItems = [];

  for (const seed of seeds) {
    try {
      console.log(`    📡 [Discovery Engine] Exploration de l'axe : "${seed}"...`);
      
      const postData = [{
        keyword: seed,
        location_code: locationCode,
        language_code: languageCode,
        limit: limit,
        include_serp_info: false
      }];

      const response = await client.post('/dataforseo_labs/google/keyword_suggestions/live', postData);
      const task = response.data.tasks[0];

      if (task.status_code === 20000 && task.result[0]?.items) {
        const items = task.result[0].items;
        console.log(`      ✅ ${items.length} pépites trouvées.`);
        allItems = [...allItems, ...items];
      } else {
        console.log(`      Ø Aucun résultat pour cet axe.`);
      }
      
      // Pause technique pour respecter les limites de l'API
      await new Promise(resolve => setTimeout(resolve, 500));

    } catch (error) {
      console.error(`    ⚠️ Erreur sur l'axe "${seed}" :`, error.message);
    }
  }

  return allItems;
}

async function getKeywordsForSite(target, locationCode = 2250, languageCode = 'fr', limit = 100) {
  try {
    const postData = [{
      target: target,
      target_type: "domain",
      location_code: locationCode,
      language_code: languageCode,
      include_serp_info: false,
      limit: limit
    }];

    const response = await client.post('/dataforseo_labs/google/keywords_for_site/live', postData);
    return response.data.tasks[0].result[0]?.items || [];
  } catch (error) { return []; }
}

module.exports = { getBulkKeywordSuggestions, getKeywordsForSite };
