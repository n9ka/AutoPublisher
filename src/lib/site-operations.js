/** Durable operation reservations live in Aspy's existing private execution log.
 * This worker never falls back to unguarded publication if the endpoint fails. */
function createSiteOperations(client, { logger = console, heartbeatMs = 30000, request = requestOperation, reservationsEnabled = process.env.SITE_TRANSFERS_ENABLED !== 'false' } = {}) {
  // Preserve the factory's first argument for callers; no Supabase RPC is used.
  void client;
  async function beginSiteOperation(siteId, expectedUserId, kind, operationKey, automation = true) {
    if (!reservationsEnabled) {
      // Outside a migration, keep ownership/pause checks on the original
      // Supabase API. Do not call Aspy or retain per-article reservations.
      const db = client || require('./supabase').supabase;
      let query = db.from('wordpress_sites').select('id,user_id,active').eq('id', siteId);
      if (expectedUserId != null) query = query.eq('user_id', expectedUserId);
      const { data: site, error } = await query.single();
      if (error || !site || typeof site.user_id !== 'string' || (expectedUserId != null && site.user_id !== expectedUserId)) throw new Error('Site unavailable or ownership changed');
      const { data: holds, error: holdError } = await db.from('execution_logs').select('metadata')
        .is('wordpress_site_id', null).eq('step', 'aspy_site_hold').eq('status', 'running').eq('metadata->>siteId', String(site.id).toLowerCase());
      if (holdError || !holds || holds.some(hold => !['transferring', 'awaiting_resume'].includes(hold.metadata?.phase))) throw new Error('Site hold could not be verified');
      if (holds.some(hold => hold.metadata.phase === 'transferring' || automation || kind === 'deleteSite') || (automation && site.active !== true)) {
        return { deferred: true, finish: async () => {}, runExternalEffect: async () => { throw new Error('SITE_TRANSFER_DEFERRED'); } };
      }
      let finished = false;
      return { deferred: false, token: null, userId: site.user_id,
        async runExternalEffect(callback) { if (finished) throw new Error('Site operation already finished'); return callback(); },
        async finish() { finished = true; },
      };
    }
    const response = await request({ action: 'begin', siteId, expectedUserId: expectedUserId ?? null, kind, operationKey: String(operationKey), automation });
    if (response?.deferred) {
      logger.log(`[site-operation] Deferred ${kind}: site transfer or automation paused.`);
      return { deferred: true, finish: async () => {}, runExternalEffect: async () => { throw new Error('SITE_TRANSFER_DEFERRED'); } };
    }
    const data = response;
    if (!data?.token || typeof data.userId !== 'string' || (expectedUserId != null && data.userId !== expectedUserId)) throw new Error('Invalid site operation response');
    let finished = false;
    let uncertainExternalEffect = false;
    let heartbeatInFlight = null;
    const timer = setInterval(() => {
      if (finished || heartbeatInFlight) return;
      heartbeatInFlight = Promise.resolve().then(() => request({ action: 'heartbeat', token: data.token }))
        .catch(() => logger.warn('[site-operation] Heartbeat unavailable; reservation remains active.'))
        .finally(() => { heartbeatInFlight = null; });
    }, heartbeatMs);
    timer.unref?.();
    return {
      deferred: false,
      token: data.token,
      userId: data.userId,
      ownerRevision: data.ownerRevision,
      async runExternalEffect(callback, { requireResult = false } = {}) {
        if (finished) throw new Error('Site operation already finished');
        try {
          const result = await callback();
          if (requireResult && (!result || result.success === false)) uncertainExternalEffect = true;
          return result;
        } catch (error) {
          uncertainExternalEffect = true;
          throw error;
        }
      },
      async finish() {
        if (finished) return;
        finished = true;
        clearInterval(timer);
        if (heartbeatInFlight) await heartbeatInFlight;
        if (uncertainExternalEffect) {
          logger.warn('[site-operation] External outcome uncertain; durable operation retained for reconciliation.');
          return;
        }
        await request({ action: 'finish', token: data.token });
      },
    };
  }
  return { beginSiteOperation };
}

async function requestOperation(body) {
  const key = process.env.SUPABASE_KEY;
  if (!key) throw new Error('Site operation server credentials are unavailable');
  let base;
  try { base = new URL(process.env.ASPY_APP_URL || 'https://www.aspy.fr'); } catch { throw new Error('Invalid Aspy application URL'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if (base.username || base.password || (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))) throw new Error('Invalid Aspy application URL');
  const endpoint = new URL('/api/internal/site-operations', base);
  let response;
  try {
    response = await fetch(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15000),
    });
  } catch { throw new Error('Site operation endpoint unavailable; publication refused'); }
  if (response.status === 409 && body.action === 'begin') return { deferred: true };
  if (!response.ok) throw new Error(`Site operation endpoint refused request (${response.status})`);
  let result;
  try { result = await response.json(); } catch { throw new Error('Invalid site operation response'); }
  if (body.action !== 'begin' && result?.success !== true) throw new Error('Site operation confirmation missing');
  return result;
}

async function beginSiteOperation(...args) {
  return createSiteOperations(null).beginSiteOperation(...args);
}

module.exports = { beginSiteOperation, createSiteOperations };
