// Authentication probe only: {} is rejected before any SQL or reservation.
async function main() {
  const key = process.env.SUPABASE_KEY;
  if (!key) throw new Error('SUPABASE_KEY is missing');
  const endpoint = 'https://www.aspy.fr/api/internal/site-operations';
  for (const authenticated of [false, true]) {
    const response = await fetch(endpoint, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: `Bearer ${key}` } : {}) },
      body: '{}',
    });
    const expected = authenticated ? 400 : 401;
    if (response.status !== expected) throw new Error(`Operation endpoint returned ${response.status}; expected ${expected}`);
  }
  console.log('Operation endpoint authentication verified; no operation requested.');
}
main().catch(() => {
  console.error('Operation endpoint authentication could not be confirmed. No publication attempted.');
  process.exitCode = 1;
});
