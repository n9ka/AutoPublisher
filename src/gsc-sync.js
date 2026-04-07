/**
 * gsc-sync.js — Sync nocturne des données GSC vers gsc_daily_metrics
 * Usage : node src/gsc-sync.js
 */

require('dotenv').config();

const { createClient } = require('@supabase/supabase-js');
const crypto = require('node:crypto');

// ─── Clients ─────────────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function createDataClient() {
  const url = process.env.CACHE_DB_URL;
  const key = process.env.CACHE_DB_SERVICE_KEY;
  if (!url || !key) throw new Error('CACHE_DB_URL ou CACHE_DB_SERVICE_KEY manquants');
  return createClient(url, key);
}

// ─── Chiffrement (identique à encryption.js) ─────────────────────────────────

function decrypt(encryptedContent, ivHex, authTagHex) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 32) throw new Error('ENCRYPTION_KEY invalide');
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));
  let decrypted = decipher.update(encryptedContent, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function encryptToken(text) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 32) throw new Error('ENCRYPTION_KEY invalide');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(key), iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  return { content: encrypted, iv: iv.toString('hex'), authTag: cipher.getAuthTag().toString('hex') };
}

// ─── Token OAuth GSC ──────────────────────────────────────────────────────────

async function getValidAccessToken(connectionId) {
  const { data: conn, error } = await supabase
    .from('gsc_connections')
    .select('access_token, access_token_iv, access_token_auth_tag, refresh_token, refresh_token_iv, refresh_token_auth_tag, token_expiry')
    .eq('id', connectionId)
    .single();

  if (error || !conn) throw new Error(`Connexion GSC introuvable (${connectionId})`);

  const expiryMs = conn.token_expiry ? new Date(conn.token_expiry).getTime() : 0;
  if (Date.now() < expiryMs - 60_000) {
    return decrypt(conn.access_token, conn.access_token_iv, conn.access_token_auth_tag);
  }

  const refreshToken = decrypt(conn.refresh_token, conn.refresh_token_iv, conn.refresh_token_auth_tag);
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: process.env.GOOGLE_GSC_CLIENT_ID,
      client_secret: process.env.GOOGLE_GSC_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) throw new Error(`Refresh token échoué (${res.status})`);
  const newTokens = await res.json();

  const encryptedAccess = encryptToken(newTokens.access_token);
  await supabase
    .from('gsc_connections')
    .update({
      access_token: encryptedAccess.content,
      access_token_iv: encryptedAccess.iv,
      access_token_auth_tag: encryptedAccess.authTag,
      token_expiry: new Date(Date.now() + newTokens.expires_in * 1000).toISOString(),
    })
    .eq('id', connectionId);

  return newTokens.access_token;
}

// ─── Fetch GSC daily data pour un site ───────────────────────────────────────

async function fetchDailyMetrics(connectionId, propertyUrl, days = 90) {
  const end = new Date();
  end.setDate(end.getDate() - 3); // GSC lag ~3 jours
  const start = new Date(end);
  start.setDate(start.getDate() - days);
  const fmt = (d) => d.toISOString().split('T')[0];

  const accessToken = await getValidAccessToken(connectionId);
  const encodedUrl = encodeURIComponent(propertyUrl);

  const res = await fetch(
    `https://www.googleapis.com/webmasters/v3/sites/${encodedUrl}/searchAnalytics/query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: fmt(start),
        endDate: fmt(end),
        dimensions: ['date'],
        rowLimit: 90,
        type: 'web',
      }),
    }
  );

  if (!res.ok) throw new Error(`GSC API ${res.status} pour ${propertyUrl}`);
  const json = await res.json();
  return json.rows ?? [];
}

// ─── Sync principal ───────────────────────────────────────────────────────────

async function syncAllSites() {
  console.log('\n[gsc-sync] Démarrage sync GSC daily metrics...\n');

  const dataClient = createDataClient();

  // Récupère tous les mappings avec infos site (user_id, name)
  const { data: mappings, error } = await supabase
    .from('gsc_site_mappings')
    .select('id, gsc_connection_id, gsc_property_url, wordpress_site_id, wordpress_sites(user_id, name)');

  if (error) throw new Error(`Impossible de charger les mappings : ${error.message}`);
  if (!mappings || mappings.length === 0) {
    console.log('[gsc-sync] Aucun mapping GSC trouvé. Fin.');
    return;
  }

  console.log(`[gsc-sync] ${mappings.length} site(s) à synchroniser\n`);

  let synced = 0;
  let failed = 0;
  let totalRows = 0;

  for (const mapping of mappings) {
    const siteName = mapping.wordpress_sites?.name ?? mapping.wordpress_site_id;
    const userId = mapping.wordpress_sites?.user_id;

    try {
      const rows = await fetchDailyMetrics(mapping.gsc_connection_id, mapping.gsc_property_url);

      if (rows.length === 0) {
        console.log(`  ⚠️  ${siteName} — aucune donnée GSC`);
        synced++;
        continue;
      }

      const upsertRows = rows.map((row) => ({
        user_id: userId,
        wordpress_site_id: mapping.wordpress_site_id,
        gsc_property_url: mapping.gsc_property_url,
        site_name: siteName,
        date: row.keys[0],
        clicks: row.clicks ?? 0,
        impressions: row.impressions ?? 0,
        ctr: row.ctr ?? 0,
        position: row.position ?? 0,
        synced_at: new Date().toISOString(),
      }));

      const { error: upsertError } = await dataClient
        .from('gsc_daily_metrics')
        .upsert(upsertRows, { onConflict: 'wordpress_site_id,date' });

      if (upsertError) throw new Error(upsertError.message);

      console.log(`  ✅ ${siteName} — ${upsertRows.length} jours upsertés`);
      synced++;
      totalRows += upsertRows.length;
    } catch (err) {
      console.error(`  ❌ ${siteName} — ${err.message}`);
      failed++;
    }
  }

  console.log(`\n[gsc-sync] Terminé : ${synced}/${mappings.length} sites OK, ${failed} erreurs, ${totalRows} rows upsertés`);
}

// ─── Entrée ───────────────────────────────────────────────────────────────────

(async () => {
  try {
    await syncAllSites();
    process.exit(0);
  } catch (err) {
    console.error('[gsc-sync] Erreur fatale :', err.message);
    process.exit(1);
  }
})();
