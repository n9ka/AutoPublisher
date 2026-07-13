const axios = require('axios');
const Parser = require('rss-parser');

const FREUDIX_RSS_BASE_URL = 'https://freudix.studio/seo-trends/rss';

// Les valeurs stockées dans trend_spies.category correspondent directement
// aux slugs des flux Freudix. Cette liste évite de construire une URL depuis
// une valeur non reconnue en base.
const FREUDIX_CATEGORIES = new Set([
  'all',
  'affaires-finance',
  'alimentation-boissons',
  'auto-vehicules',
  'autre',
  'beaute-mode',
  'climat-meteo',
  'divertissement',
  'emploi-education',
  'jeux',
  'loi-gouvernement',
  'loisirs-passe-temps',
  'politique',
  'sante',
  'sciences',
  'shopping',
  'sports',
  'technologie',
  'voyage-transport'
]);

const GOOGLE_NEWS_TOPIC_MAP = {
  technologie: 'TECHNOLOGY',
  'affaires-finance': 'BUSINESS',
  sante: 'HEALTH',
  sports: 'SPORTS',
  divertissement: 'ENTERTAINMENT',
  sciences: 'SCIENCE'
};

function getFreudixFeedUrl(category = 'all') {
  const safeCategory = FREUDIX_CATEGORIES.has(category) ? category : 'all';
  return safeCategory === 'all'
    ? `${FREUDIX_RSS_BASE_URL}.xml`
    : `${FREUDIX_RSS_BASE_URL}/${safeCategory}.xml`;
}

function parseMetricNumber(rawValue) {
  if (!rawValue) return null;

  const normalizedValue = String(rawValue)
    .replace(/[\u00A0\u202F]/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '');
  const match = normalizedValue.match(/^(\d+(?:[.,]\d+)?)([km])?\+?$/i);
  if (!match) return null;

  const value = Number.parseFloat(match[1].replace(',', '.'));
  if (!Number.isFinite(value)) return null;

  const multiplier = match[2]?.toLowerCase() === 'm'
    ? 1_000_000
    : match[2]?.toLowerCase() === 'k'
      ? 1_000
      : 1;

  return Math.round(value * multiplier);
}

function extractFreudixMetrics(description = '') {
  const trendsTraffic = parseMetricNumber(description.match(/tendance\s*↗\s*([^·]+)/iu)?.[1]);
  const searchVolume = parseMetricNumber(description.match(/([\d\s\u00A0\u202F.,]+)\/mois/iu)?.[1]);

  return { trendsTraffic, searchVolume };
}

function mapRssItem(item) {
  const title = (item.title || '').trim();
  const snippet = item.contentSnippet || item.content || item.summary || '';

  return {
    title,
    ...extractFreudixMetrics(snippet),
    articles: [{
      title,
      snippet,
      url: item.link || ''
    }]
  };
}

async function getFreudixTrends(category = 'all') {
  const parser = new Parser();
  const url = getFreudixFeedUrl(category);

  console.log(`  🔍 Veille Freudix [${category}]...`);
  const response = await axios.get(url, {
    headers: {
      Accept: 'application/rss+xml, application/xml, text/xml',
      'User-Agent': 'Aspy Trend Spy/1.0'
    },
    timeout: 15000
  });

  const feed = await parser.parseString(response.data);
  const trends = (feed?.items || [])
    .map(mapRssItem)
    .filter((trend) => trend.title);

  console.log(`✅ Freudix : ${trends.length} tendances détectées.`);
  return trends;
}

/**
 * Fallback historique si Freudix est indisponible ou ne renvoie aucune tendance.
 */
async function getGoogleNewsTrends(category = 'all') {
  try {
    const parser = new Parser();
    const topic = GOOGLE_NEWS_TOPIC_MAP[category] || '';
    const url = topic
      ? `https://news.google.com/rss/headlines/section/topic/${topic}?hl=fr&gl=FR&ceid=FR:fr`
      : 'https://news.google.com/rss?hl=fr&gl=FR&ceid=FR:fr';

    console.log(`  ↪️ Fallback Google News [${topic || 'TOP STORIES'}]...`);
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
      },
      timeout: 15000
    });

    const feed = await parser.parseString(response.data);
    const trends = (feed?.items || [])
      .map(mapRssItem)
      .filter((trend) => trend.title);

    console.log(`✅ Google News : ${trends.length} articles détectés.`);
    return trends;
  } catch (error) {
    console.error('❌ Échec du fallback Google News:', error.message);
    return [];
  }
}

/**
 * Récupère les tendances SEO Freudix pour la catégorie demandée.
 * En cas d'indisponibilité, conserve Google News comme filet de sécurité.
 */
async function getDailyTrends(category = 'all') {
  try {
    const trends = await getFreudixTrends(category);
    if (trends.length > 0) return trends;

    console.warn('⚠️ Flux Freudix vide, utilisation du fallback Google News.');
  } catch (error) {
    console.error('❌ Échec du flux Freudix:', error.message);
  }

  return getGoogleNewsTrends(category);
}

module.exports = { getDailyTrends };
