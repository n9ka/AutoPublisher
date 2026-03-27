const axios = require('axios');

function formatContext(results) {
  return results.map((res, i) => {
    return `[Source ${i + 1}: ${res.url}]\nTITRE: ${res.title}\nCONTENU: ${res.snippet || ""}\n`;
  }).join('\n---\n');
}

async function searchWithLangSearch(query) {
  if (!process.env.LANGSEARCH_API_KEY) {
    console.warn('  ⚠️ LANGSEARCH_API_KEY manquante. Recherche impossible.');
    return "";
  }

  try {
    console.log(`  🌐 Recherche LangSearch pour : "${query}"...`);

    const response = await axios.post('https://api.langsearch.com/v1/web-search', {
      query: query,
      freshness: 'oneDay',
      summary: true,
      count: 5
    }, {
      headers: {
        'Authorization': `Bearer ${process.env.LANGSEARCH_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    const rawResults = response.data?.data || response.data?.results || [];
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      console.warn('  ⚠️ LangSearch : Aucun résultat trouvé.');
      return "";
    }

    const normalized = rawResults
      .map((res) => ({
        url: res.url,
        title: res.title,
        snippet: res.snippet || res.summary || ""
      }))
      .filter((res) => res.url && res.title);

    if (!normalized.length) {
      console.warn('  ⚠️ LangSearch : Résultats non exploitables.');
      return "";
    }

    return formatContext(normalized);
  } catch (error) {
    console.error('  ❌ Erreur LangSearch:', error.response?.data?.message || error.message);
    return "";
  }
}

async function searchBrave(query, raw = false) {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  if (!braveKey) {
    console.warn('  ⚠️ BRAVE_API_KEY manquante.');
    return raw ? [] : "";
  }

  try {
    console.log(`  🌐 Recherche Brave Search pour : "${query}"...`);

    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: {
        q: query,
        count: 5
      },
      headers: {
        'Accept': 'application/json',
        'X-Subscription-Token': braveKey
      }
    });

    const rawResults = response.data?.web?.results || [];
    if (!Array.isArray(rawResults) || rawResults.length === 0) {
      console.warn('  ⚠️ Brave Search : Aucun résultat trouvé.');
      return raw ? [] : "";
    }

    const normalized = rawResults
      .map((res) => ({
        url: res.url,
        title: res.title,
        snippet: res.description || ""
      }))
      .filter((res) => res.url && res.title);

    if (!normalized.length) {
      console.warn('  ⚠️ Brave Search : Résultats non exploitables.');
      return raw ? [] : "";
    }

    return raw ? normalized : formatContext(normalized);
  } catch (error) {
    console.error('  ❌ Erreur Brave Search:', error.response?.data?.message || error.message);
    return raw ? [] : "";
  }
}

/**
 * Effectue une recherche web via LangSearch pour enrichir un sujet
 * @param {string} query - Le sujet ou la tendance à rechercher
 */
async function researchTopic(query) {
  const langsearchContext = await searchWithLangSearch(query);
  if (langsearchContext) return langsearchContext;
  return await searchBrave(query);
}

module.exports = { researchTopic, searchBrave };
