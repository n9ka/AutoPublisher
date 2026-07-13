const axios = require('axios');

const FREUDIX_MCP_URL = 'https://freudix.studio/api/mcp';

function normalizeKeyword(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function parseTrendMetricsResponse(payload, keyword) {
  const text = payload?.result?.content?.find((item) => item.type === 'text')?.text;
  if (!text) return null;

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }

  const trends = Array.isArray(data.trends) ? data.trends : [];
  const expectedKeyword = normalizeKeyword(keyword);
  const exactMatch = trends.find((trend) => normalizeKeyword(trend.keyword) === expectedKeyword);
  const partialMatch = trends.find((trend) => {
    const candidate = normalizeKeyword(trend.keyword);
    return candidate && expectedKeyword && (candidate.includes(expectedKeyword) || expectedKeyword.includes(candidate));
  });
  const trend = exactMatch || partialMatch;
  if (!trend) return null;

  return {
    keyword: trend.keyword,
    trendsTraffic: Number(trend.trends_traffic) || 0,
    searchVolume: Number(trend.search_volume) || 0,
    cpc: typeof trend.cpc === 'number' ? trend.cpc : Number(trend.cpc) || null,
    competition: typeof trend.competition === 'number' ? trend.competition : Number(trend.competition) || 0,
    updatedAt: data.updated_at || null,
    analyzeUrl: trend.analyze || null,
  };
}

async function getFreudixTrendMetrics(keyword) {
  try {
    const response = await axios.post(FREUDIX_MCP_URL, {
      jsonrpc: '2.0',
      id: `aspy-trend-${Date.now()}`,
      method: 'tools/call',
      params: {
        name: 'search_seo_trends',
        arguments: {
          query: keyword,
          limit: 5,
        },
      },
    }, {
      headers: {
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2025-03-26',
      },
      timeout: 8000,
    });

    return parseTrendMetricsResponse(response.data, keyword);
  } catch (error) {
    console.warn(`  ⚠️ Enrichissement Freudix indisponible : ${error.response?.status || error.message}`);
    return null;
  }
}

module.exports = { getFreudixTrendMetrics, normalizeKeyword, parseTrendMetricsResponse };
