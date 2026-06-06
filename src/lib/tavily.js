const axios = require('axios');

const PRIMARY_KEY_ENV = 'TAVILY_API_KEY';
const FALLBACK_KEY_ENV = 'TAVILY_API_KEY_FALLBACK';
const DEFAULT_PRIMARY_SOFT_LIMIT = 950;

let cachedSelection = null;

function getEnvValue(name) {
  return (process.env[name] || '').replace(/"/g, '').trim();
}

function getConfiguredKeys() {
  const primary = getEnvValue(PRIMARY_KEY_ENV);
  const fallback = getEnvValue(FALLBACK_KEY_ENV);
  return {
    primary,
    fallback: fallback && fallback !== primary ? fallback : null,
  };
}

function maskKey(apiKey) {
  if (!apiKey || apiKey.length < 10) return 'unknown';
  return `${apiKey.slice(0, 7)}...${apiKey.slice(-4)}`;
}

function getPrimarySoftLimit(limit) {
  const raw = Number.parseInt(process.env.TAVILY_PRIMARY_SOFT_LIMIT || '', 10);
  const configured = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRIMARY_SOFT_LIMIT;
  return typeof limit === 'number' && limit > 0 ? Math.min(configured, limit) : configured;
}

function getCurrentMonthKey() {
  return new Date().toISOString().slice(0, 7);
}

function extractUsageNumbers(data = {}) {
  const usage = data?.key?.usage ?? data?.usage ?? data?.current_usage ?? null;
  const limit = data?.key?.limit ?? data?.limit ?? data?.usage_limit ?? null;
  return {
    usage: typeof usage === 'number' ? usage : Number(usage),
    limit: typeof limit === 'number' ? limit : Number(limit),
  };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function shouldRetryWithAlternateKey(error) {
  const status = error?.response?.status;
  const message = JSON.stringify(error?.response?.data || '').toLowerCase();

  if (status === 401 || status === 403) return true;
  if (status === 429) return true;
  if (message.includes('credit')) return true;
  if (message.includes('quota')) return true;
  if (message.includes('rate limit')) return true;
  if (message.includes('too many requests')) return true;
  if (message.includes('exceeded')) return true;
  return false;
}

async function fetchUsage(apiKey) {
  const response = await axios.get('https://api.tavily.com/usage', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    timeout: 8000,
  });

  return extractUsageNumbers(response.data);
}

async function selectApiKey() {
  const { primary, fallback } = getConfiguredKeys();
  if (!primary) {
    console.warn(`  ⚠️ ${PRIMARY_KEY_ENV} manquante.`);
    return null;
  }

  const monthKey = getCurrentMonthKey();
  if (cachedSelection?.monthKey === monthKey && cachedSelection?.apiKey) {
    return cachedSelection;
  }

  // Mode simplifié :
  // - on utilise toujours la clé primaire ;
  // - on ne fait plus d'appel automatique à /usage ;
  // - la clé fallback reste configurée mais n'est plus sélectionnée
  //   automatiquement en fonction du quota.
  //
  // Pour revenir à l'ancien comportement de rotation auto en fin de mois,
  // restaurer le bloc ci-dessous et retirer ce retour anticipé.
  cachedSelection = {
    apiKey: primary,
    source: 'primary',
    reason: 'primary_forced_manual_rotation',
    monthKey,
  };
  return cachedSelection;

  /*
  if (!fallback) {
    cachedSelection = {
      apiKey: primary,
      source: 'primary',
      reason: 'fallback_absent',
      monthKey,
    };
    return cachedSelection;
  }

  try {
    const usageData = await fetchUsage(primary);
    const usage = isFiniteNumber(usageData.usage) ? usageData.usage : null;
    const limit = isFiniteNumber(usageData.limit) ? usageData.limit : null;
    const softLimit = getPrimarySoftLimit(limit);

    if (usage !== null && usage >= softLimit) {
      cachedSelection = {
        apiKey: fallback,
        source: 'fallback',
        reason: `primary_soft_limit_reached:${usage}/${limit ?? '?'}`,
        monthKey,
      };
      console.warn(`  ⚠️ Tavily primaire proche de la limite (${usage}/${limit ?? '?'}). Bascule sticky vers la clé secondaire.`);
      return cachedSelection;
    }

    cachedSelection = {
      apiKey: primary,
      source: 'primary',
      reason: usage !== null ? `primary_usage_ok:${usage}/${limit ?? '?'}` : 'primary_usage_unknown',
      monthKey,
    };
    return cachedSelection;
  } catch (error) {
    console.warn(`  ⚠️ Impossible de lire l'usage Tavily primaire, conservation de la clé primaire. ${error.response?.status || error.message}`);
    cachedSelection = {
      apiKey: primary,
      source: 'primary',
      reason: 'usage_check_failed',
      monthKey,
    };
    return cachedSelection;
  }
  */
}

async function callTavily(endpoint, payload, actionLabel) {
  const selection = await selectApiKey();
  if (!selection?.apiKey) return null;

  const { primary, fallback } = getConfiguredKeys();
  const alternateKey = selection.apiKey === primary ? fallback : primary;
  const attempts = [{ apiKey: selection.apiKey, source: selection.source, reason: selection.reason }];
  let lastError = null;

  if (alternateKey) {
    attempts.push({
      apiKey: alternateKey,
      source: selection.apiKey === primary ? 'fallback' : 'primary',
      reason: 'retry_on_quota_or_auth_error',
    });
  }

  for (let index = 0; index < attempts.length; index++) {
    const attempt = attempts[index];
    try {
      if (index === 0) {
        console.log(`  🌐 ${actionLabel} via Tavily (${attempt.source}, ${attempt.reason})...`);
      } else {
        console.warn(`  ⚠️ Retry Tavily via clé ${attempt.source} (${maskKey(attempt.apiKey)})...`);
      }

      const response = await axios.post(`https://api.tavily.com/${endpoint}`, payload, {
        headers: {
          Authorization: `Bearer ${attempt.apiKey}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      });

      if (attempt.source !== selection.source) {
        cachedSelection = {
          apiKey: attempt.apiKey,
          source: attempt.source,
          reason: 'runtime_failover_success',
          monthKey: getCurrentMonthKey(),
        };
      }

      return response.data;
    } catch (error) {
      lastError = error;
      const canRetry = index === 0 && attempts[index + 1] && shouldRetryWithAlternateKey(error);
      console.error(`  ❌ Erreur Tavily (${attempt.source}):`, error.response?.data || error.message);
      if (!canRetry) break;
    }
  }

  if (lastError) {
    console.error(`  ❌ Échec final Tavily ${actionLabel.toLowerCase()}.`);
  }
  return null;
}

/**
 * Effectue une recherche web via Tavily (IA Search)
 * Offre 1000 recherches gratuites/mois.
 */
async function researchWithTavily(query) {
  const data = await callTavily('search', {
    query,
    search_depth: 'advanced',
    include_answer: true,
    max_results: 5,
  }, `Recherche Tavily pour : "${query}"`);

  if (!data) return null;

  const results = data.results || [];
  const answer = data.answer || '';

  const context = results.map((res, i) => {
    return `[Source ${i + 1}: ${res.url}]\nTITRE: ${res.title}\nCONTENU: ${res.content}\n`;
  }).join('\n---\n');

  return `SYNTHÈSE IA TAVILY: ${answer}\n\nSOURCES DÉTAILLÉES:\n${context}`;
}

async function extractWithTavily(url) {
  const data = await callTavily('extract', {
    urls: [url],
  }, `Tavily Extract pour : ${url}`);

  const result = (data?.results || [])[0];
  if (!result?.raw_content || result.raw_content.length < 200) return null;
  return result.raw_content;
}

module.exports = { researchWithTavily, extractWithTavily };
