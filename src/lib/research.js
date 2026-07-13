const axios = require('axios');
const { LANG_TO_BRAVE } = require('./languages');
const { researchWithTavily } = require('./tavily');

const MAX_CONTEXT_PER_SOURCE = 7000;
const MAX_TREND_RESEARCH_CONTEXT = 42000;
const MIN_TREND_SOURCE_COUNT = 3;
const MIN_TREND_CONTEXT_CHARS = 8000;

function getDomain(url = '') {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function normalizeLangSearchResults(payload = {}) {
  const rawResults = payload?.data?.webPages?.value || payload?.data || payload?.results || [];
  if (!Array.isArray(rawResults)) return [];

  return rawResults
    .map((res) => ({
      url: res.url,
      title: res.name || res.title,
      // LangSearch fournit un résumé beaucoup plus riche que le snippet SERP.
      content: res.summary || res.snippet || '',
      snippet: res.snippet || '',
      publishedAt: res.datePublished || null,
      provider: 'LangSearch',
    }))
    .filter((res) => res.url && res.title && res.content);
}

function normalizeBraveResults(rawResults = []) {
  if (!Array.isArray(rawResults)) return [];

  return rawResults
    .map((res) => ({
      url: res.url,
      title: res.title,
      content: res.description || '',
      snippet: res.description || '',
      provider: 'Brave',
    }))
    .filter((res) => res.url && res.title && res.content);
}

function formatContext(results, { maxPerSource = MAX_CONTEXT_PER_SOURCE, label } = {}) {
  const header = label ? `# RECHERCHE ${label.toUpperCase()}\n` : '';
  const content = results.map((res, i) => {
    const sourceContent = (res.content || res.summary || res.snippet || '').slice(0, maxPerSource);
    return `[Source ${i + 1}: ${res.url}]\nTITRE: ${res.title}\nCONTENU: ${sourceContent}\n`;
  }).join('\n---\n');
  return `${header}${content}`.trim();
}

function assessTrendResearch(results) {
  const sourceCount = results.length;
  const distinctDomainCount = new Set(results.map((result) => getDomain(result.url)).filter(Boolean)).size;
  const contentChars = results.reduce((total, result) => total + (result.content || '').length, 0);

  let reason = '';
  if (sourceCount < MIN_TREND_SOURCE_COUNT) reason = 'moins de trois sources exploitables';
  else if (distinctDomainCount < MIN_TREND_SOURCE_COUNT) reason = 'sources insuffisamment diversifiées';
  else if (contentChars < MIN_TREND_CONTEXT_CHARS) reason = 'contexte source trop court';

  return {
    sourceCount,
    distinctDomainCount,
    contentChars,
    needsTavily: Boolean(reason),
    reason,
  };
}

async function searchWithLangSearch(query, raw = false) {
  if (!process.env.LANGSEARCH_API_KEY) {
    console.warn('  ⚠️ LANGSEARCH_API_KEY manquante. Recherche impossible.');
    return raw ? [] : '';
  }

  try {
    console.log(`  🌐 Recherche LangSearch pour : "${query}"...`);

    const response = await axios.post('https://api.langsearch.com/v1/web-search', {
      query,
      freshness: 'oneDay',
      summary: true,
      count: 5,
    }, {
      headers: {
        Authorization: `Bearer ${process.env.LANGSEARCH_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 20000,
    });

    const normalized = normalizeLangSearchResults(response.data);
    if (!normalized.length) {
      console.warn('  ⚠️ LangSearch : Aucun résultat exploitable.');
      return raw ? [] : '';
    }

    return raw ? normalized : formatContext(normalized, { label: 'LangSearch' });
  } catch (error) {
    console.error('  ❌ Erreur LangSearch:', error.response?.data?.message || error.message);
    return raw ? [] : '';
  }
}

async function searchBrave(query, raw = false, langCode = 'fr') {
  const braveKey = process.env.BRAVE_SEARCH_API_KEY || process.env.BRAVE_API_KEY;
  if (!braveKey) {
    console.warn('  ⚠️ BRAVE_API_KEY manquante.');
    return raw ? [] : '';
  }

  try {
    console.log(`  🌐 Recherche Brave Search pour : "${query}"...`);

    const geo = LANG_TO_BRAVE[langCode] || LANG_TO_BRAVE.fr;
    const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
      params: {
        q: query,
        count: 5,
        country: geo.country,
        search_lang: geo.search_lang,
      },
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': braveKey,
      },
      timeout: 20000,
    });

    const normalized = normalizeBraveResults(response.data?.web?.results || []);
    if (!normalized.length) {
      console.warn('  ⚠️ Brave Search : Aucun résultat exploitable.');
      return raw ? [] : '';
    }

    return raw ? normalized : formatContext(normalized, { label: 'Brave' });
  } catch (error) {
    console.error('  ❌ Erreur Brave Search:', error.response?.data?.message || error.message);
    return raw ? [] : '';
  }
}

/**
 * Recherche standard : LangSearch frais, puis Brave seulement en secours.
 * Conservée pour les appels existants hors Trend Spy.
 */
async function researchTopic(query, langCode = 'fr') {
  const langsearchContext = await searchWithLangSearch(query);
  if (langsearchContext) return langsearchContext;
  return searchBrave(query, false, langCode);
}

/**
 * Recherche éditoriale Trend Spy. Tavily n'est utilisé que si le contexte
 * LangSearch/Brave est trop court ou pas assez diversifié, afin de préserver
 * le quota tout en fiabilisant les sujets sensibles ou mal documentés.
 */
async function researchTrendTopic(query, langCode = 'fr') {
  let sources = await searchWithLangSearch(query, true);
  let provider = 'LangSearch';

  if (!sources.length) {
    sources = await searchBrave(query, true, langCode);
    provider = 'Brave';
  }

  const quality = assessTrendResearch(sources);
  const sections = [];
  if (sources.length) sections.push(formatContext(sources, { label: provider }));

  let usedTavily = false;
  if (quality.needsTavily && process.env.TAVILY_API_KEY) {
    console.log(`  🔎 Contexte ${provider} insuffisant (${quality.reason}) : enrichissement Tavily.`);
    const tavilyContext = await researchWithTavily(query);
    if (tavilyContext) {
      sections.push(`# RECHERCHE TAVILY (ENRICHISSEMENT)\n${tavilyContext.slice(0, 18000)}`);
      usedTavily = true;
    }
  } else if (quality.needsTavily) {
    console.warn(`  ⚠️ Contexte recherche limité (${quality.reason}) et Tavily indisponible.`);
  }

  return {
    context: sections.join('\n\n=====\n\n').slice(0, MAX_TREND_RESEARCH_CONTEXT),
    meta: {
      provider,
      source_count: quality.sourceCount,
      distinct_domain_count: quality.distinctDomainCount,
      context_chars: quality.contentChars,
      used_tavily: usedTavily,
      quality_reason: quality.reason || 'contexte LangSearch suffisant',
    },
  };
}

module.exports = {
  assessTrendResearch,
  normalizeLangSearchResults,
  researchTopic,
  researchTrendTopic,
  searchBrave,
};
