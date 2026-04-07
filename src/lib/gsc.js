/**
 * Google Search Console client pour AutoPublisher
 * Utilisé par seo-lab.js pour enrichir les opportunités avec les données GSC réelles.
 */

const crypto = require('node:crypto');

const ALGORITHM = 'aes-256-gcm';

// ─── Chiffrement (même logique que Aspy.fr/src/lib/encryption.ts) ────────────

function decrypt(encryptedContent, ivHex, authTagHex) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 32) throw new Error('ENCRYPTION_KEY invalide');

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    Buffer.from(key),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'));

  let decrypted = decipher.update(encryptedContent, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

// ─── Token management ────────────────────────────────────────────────────────

async function getValidAccessToken(connectionId, supabase) {
  const { data: conn, error } = await supabase
    .from('gsc_connections')
    .select('access_token, access_token_iv, access_token_auth_tag, refresh_token, refresh_token_iv, refresh_token_auth_tag, token_expiry')
    .eq('id', connectionId)
    .single();

  if (error || !conn) throw new Error('Connexion GSC introuvable');

  const expiryMs = conn.token_expiry ? new Date(conn.token_expiry).getTime() : 0;
  const needsRefresh = Date.now() >= expiryMs - 60_000;

  if (!needsRefresh) {
    return decrypt(conn.access_token, conn.access_token_iv, conn.access_token_auth_tag);
  }

  // Refresh
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

  if (!res.ok) throw new Error(`Refresh token Google échoué (${res.status})`);

  const newTokens = await res.json();

  // Chiffrer et mettre à jour le token en DB
  const encryptedAccess = encryptToken(newTokens.access_token);
  const newExpiry = new Date(Date.now() + newTokens.expires_in * 1000).toISOString();

  await supabase
    .from('gsc_connections')
    .update({
      access_token: encryptedAccess.content,
      access_token_iv: encryptedAccess.iv,
      access_token_auth_tag: encryptedAccess.authTag,
      token_expiry: newExpiry,
    })
    .eq('id', connectionId);

  return newTokens.access_token;
}

function encryptToken(text) {
  const key = process.env.ENCRYPTION_KEY;
  if (!key || key.length !== 32) throw new Error('ENCRYPTION_KEY invalide');

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, Buffer.from(key), iv);

  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return { content: encrypted, iv: iv.toString('hex'), authTag };
}

// ─── GSC API ─────────────────────────────────────────────────────────────────

/**
 * Récupère les top requêtes GSC pour un site, sur les N derniers jours.
 * Retourne null si aucun mapping GSC n'existe pour ce site.
 */
async function getTopGscQueries(siteId, supabase, days = 90) {
  const { data: mapping } = await supabase
    .from('gsc_site_mappings')
    .select('gsc_connection_id, gsc_property_url')
    .eq('wordpress_site_id', siteId)
    .single();

  if (!mapping) return null;

  const endDate = new Date();
  endDate.setDate(endDate.getDate() - 3); // GSC lag
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - days);

  const fmt = (d) => d.toISOString().split('T')[0];

  try {
    const accessToken = await getValidAccessToken(mapping.gsc_connection_id, supabase);
    const encodedUrl = encodeURIComponent(mapping.gsc_property_url);

    const res = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodedUrl}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startDate: fmt(startDate),
          endDate: fmt(endDate),
          dimensions: ['query', 'page'],
          rowLimit: 1000,
          type: 'web',
        }),
      }
    );

    if (!res.ok) {
      console.warn(`[GSC] searchAnalytics échoué (${res.status}) pour ${mapping.gsc_property_url}`);
      return null;
    }

    const json = await res.json();
    return json.rows ?? [];
  } catch (err) {
    console.warn('[GSC] Erreur lors de la récupération des données:', err.message);
    return null;
  }
}

/**
 * Enrichit une liste d'opportunités avec les données GSC.
 * Modifie les objets en place (gsc_impressions, gsc_position, gsc_existing_page_url).
 */
async function enrichOpportunitiesWithGsc(opportunities, siteId, supabase) {
  const gscRows = await getTopGscQueries(siteId, supabase);
  if (!gscRows || gscRows.length === 0) return;

  console.log(`[GSC] ${gscRows.length} requêtes récupérées — enrichissement des opportunités`);

  for (const opp of opportunities) {
    const normalized = normalize(opp.keyword);
    const match = gscRows.find((r) => {
      const q = normalize(r.keys[0]);
      return q === normalized || levenshtein(q, normalized) <= 2;
    });

    if (match && match.position <= 30) {
      opp.gsc_impressions = match.impressions;
      opp.gsc_position = Math.round(match.position * 10) / 10;
      opp.gsc_existing_page_url = match.keys[1] ?? null;
    }
  }
}

// ─── Utilitaires ─────────────────────────────────────────────────────────────

function normalize(str) {
  return str.toLowerCase().replace(/[^a-z0-9àâäéèêëîïôùûü\s]/g, '').trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

module.exports = { getTopGscQueries, enrichOpportunitiesWithGsc };
