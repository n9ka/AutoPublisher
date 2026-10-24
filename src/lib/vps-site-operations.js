/** HTTP lease protocol for the standalone publisher, which has no Supabase key. */
async function beginVpsSiteOperation(site, {
  apiUrl = process.env.ASPY_API_URL || 'https://aspy.fr',
  apiKey = process.env.CATALOGUE_API_KEY,
  client = require('axios'), logger = console, heartbeatMs = 30000,
} = {}) {
  if (!apiKey) throw new Error('CATALOGUE_API_KEY manquant');
  const endpoint = `${apiUrl.replace(/\/$/, '')}/api/vps/site-config`;
  const requestOptions = { headers: { 'x-api-key': apiKey }, timeout: 10000 };
  let response;
  try {
    response = await client.get(endpoint, { ...requestOptions, params: { site, operation: 'begin' } });
  } catch (error) {
    if (error.response?.status === 409 && error.response?.data?.error === 'SITE_TRANSFER_DEFERRED') {
      return { deferred: true };
    }
    // Axios errors can retain credential-bearing request configuration.
    throw new Error('VPS site operation acquisition unavailable');
  }
  const config = response.data;
  if (!config || !Object.hasOwn(config, 'operation_token')) throw new Error('VPS lease protocol unavailable');
  const token = config.operation_token;
  if (token === null) {
    throw new Error('Site operation reservation unavailable; publication refused');
  }
  if (typeof token !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    throw new Error('Invalid VPS operation token');
  }
  let finished = false;
  let uncertain = false;
  let heartbeatInFlight = null;
  const timer = setInterval(() => {
    if (finished || heartbeatInFlight) return;
    heartbeatInFlight = Promise.resolve()
      .then(() => client.post(endpoint, { token, action: 'heartbeat' }, requestOptions))
      .catch(() => logger.warn('[vps-operation] Heartbeat unavailable; operation remains active.'))
      .finally(() => { heartbeatInFlight = null; });
  }, heartbeatMs);
  timer.unref?.();
  return { deferred: false, config, operation: {
    async runExternalEffect(callback, { requireResult = false } = {}) {
      if (finished) throw new Error('VPS operation already finished');
      try {
        const result = await callback();
        if (requireResult && (!result || result.success === false)) uncertain = true;
        return result;
      } catch (error) { uncertain = true; throw error; }
    },
    async finish() {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (heartbeatInFlight) await heartbeatInFlight;
      if (uncertain) {
        logger.warn('[vps-operation] External outcome uncertain; durable operation retained for reconciliation.');
        return;
      }
      try { await client.post(endpoint, { token, action: 'finish' }, requestOptions); }
      catch {
        logger.warn('[vps-operation] Release unavailable; durable operation remains active.');
        throw new Error('VPS operation release requires reconciliation');
      }
    },
  } };
}

module.exports = { beginVpsSiteOperation };
