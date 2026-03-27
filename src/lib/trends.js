const axios = require('axios');
const Parser = require('rss-parser');

/**
 * Mappe les catégories internes vers les thématiques Google News
 */
const TOPIC_MAP = {
  'all': '',
  't': 'TECHNOLOGY',
  'b': 'BUSINESS',
  'm': 'HEALTH',
  's': 'SPORTS',
  'e': 'ENTERTAINMENT',
  'sc': 'SCIENCE',
  'w': 'WORLD',
  'n': 'NATION'
};

/**
 * Récupère les actualités via Google News RSS (Solution stable et thématique)
 */
async function getDailyTrends(category = 'all', geo = 'FR') {
  try {
    const parser = new Parser();
    const topic = TOPIC_MAP[category] || '';
    
    // URL de base pour les thématiques
    let url = `https://news.google.com/rss/headlines/section/topic/${topic}?hl=fr&gl=FR&ceid=FR:fr`;
    
    // Si pas de thématique précise, on prend la une
    if (!topic) {
      url = `https://news.google.com/rss?hl=fr&gl=FR&ceid=FR:fr`;
    }

    console.log(`  🔍 Veille sur Google News [${topic || 'TOP STORIES'}]...`);

    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      }
    });

    const feed = await parser.parseString(response.data);
    const trends = [];

    if (feed && feed.items) {
      feed.items.forEach(item => {
        trends.push({
          title: item.title,
          articles: [
            {
              title: item.title,
              snippet: item.contentSnippet || item.content || "",
              url: item.link
            }
          ]
        });
      });
    }

    console.log(`✅ Google News : ${trends.length} articles détectés.`);
    return trends;

  } catch (error) {
    console.error('❌ Échec Google News RSS:', error.message);
    return [];
  }
}

module.exports = { getDailyTrends };