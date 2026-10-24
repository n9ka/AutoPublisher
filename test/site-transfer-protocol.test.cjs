const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSiteOperations } = require('../src/lib/site-operations');
const quiet = { log() {}, warn() {} };
const lease = { token: '10000000-0000-4000-8000-000000000001', userId: 'owner' };
function factory(request) { return createSiteOperations(null, { request, logger: quiet }); }
test('paused or transferring site cannot execute external effects', async () => {
  const actions = [];
  const op = await factory(async body => { actions.push(body.action); return { deferred: true }; }).beginSiteOperation('site', 'owner', 'publish', 'job');
  let published = false;
  await assert.rejects(op.runExternalEffect(async () => { published = true; }));
  await op.finish(); assert.equal(published, false); assert.deepEqual(actions, ['begin']);
});
test('normal operation remains reserved through its external effect and is finished once', async () => {
  const actions = [];
  const op = await factory(async body => { actions.push(body.action); return body.action === 'begin' ? lease : { success: true }; }).beginSiteOperation('site', 'owner', 'publish', 'job');
  assert.equal(await op.runExternalEffect(async () => { assert.deepEqual(actions, ['begin']); return 'published'; }), 'published');
  await op.finish(); await op.finish(); assert.deepEqual(actions, ['begin', 'finish']);
  await assert.rejects(op.runExternalEffect(async () => 'again'));
});
test('uncertain external result keeps reservation instead of releasing it', async () => {
  for (const callback of [async () => { throw Error('timeout'); }, async () => null, async () => ({ success: false })]) {
    const actions = [];
    const op = await factory(async body => { actions.push(body.action); return lease; }).beginSiteOperation('site', 'owner', 'publish', 'job');
    try { await op.runExternalEffect(callback, { requireResult: true }); } catch { /* simulated timeout */ }
    await op.finish(); assert.deepEqual(actions, ['begin']);
  }
});
test('missing token, wrong owner, or request failure refuses the operation', async () => {
  for (const response of [{}, { ...lease, userId: 'other' }]) {
    await assert.rejects(factory(async () => response).beginSiteOperation('site', 'owner', 'publish', 'job'));
  }
  await assert.rejects(factory(async () => { throw Error('offline'); }).beginSiteOperation('site', 'owner', 'publish', 'job'));
});
test('default HTTP origin is canonical and redirects are refused', async () => {
  const saved = { fetch: global.fetch, key: process.env.SUPABASE_KEY, origin: process.env.ASPY_APP_URL };
  process.env.SUPABASE_KEY = 'test-private-key'; delete process.env.ASPY_APP_URL;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return { status: 200, ok: true, json: async () => JSON.parse(options.body).action === 'begin' ? lease : { success: true } };
  };
  try {
    const op = await createSiteOperations(null).beginSiteOperation('site', 'owner', 'publish', 'job');
    await op.finish();
    assert.equal(calls.length, 2);
    for (const call of calls) { assert.equal(call.url, 'https://www.aspy.fr/api/internal/site-operations'); assert.equal(call.options.redirect, 'error'); }
    global.fetch = async () => ({ status: 503, ok: false });
    await assert.rejects(createSiteOperations(null).beginSiteOperation('site', 'owner', 'publish', 'job'));
    global.fetch = async () => ({ status: 409, ok: false });
    assert.equal((await createSiteOperations(null).beginSiteOperation('site', 'owner', 'publish', 'job')).deferred, true);
  } finally {
    global.fetch = saved.fetch;
    for (const [key, value] of [['SUPABASE_KEY', saved.key], ['ASPY_APP_URL', saved.origin]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
