require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('./lib/supabase');
const { decrypt } = require('./lib/encryption');

function createDataClient() {
  return createClient(process.env.CACHE_DB_URL, process.env.CACHE_DB_SERVICE_KEY);
}

function getHeaders(baseUrl, auth, bridgeKey = null) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Cache-Control': 'no-cache',
  };
  if (bridgeKey) {
    headers['X-Bridge-Auth'] = bridgeKey;
    headers['Authorization'] = `Bearer ${bridgeKey}`;
  } else if (auth) {
    headers['Authorization'] = `Basic ${auth}`;
  }
  return headers;
}

async function fetchSitePosts(site, afterDate) {
  const baseUrl = (site.url || '').replace(/\/$/, '');
  if (!baseUrl) return [];

  const isBridge = site.connection_mode === 'bridge_plugin' && site.bridge_key;
  const auth = !isBridge
    ? Buffer.from(`${site.wp_user}:${site.wp_password}`).toString('base64')
    : null;

  const params = {
    per_page: 100,
    status: 'publish,future',
    _fields: 'id,title,slug,link,status,date',
    after: afterDate,
    orderby: 'date',
    order: 'asc',
  };

  try {
    const response = await axios.get(`${baseUrl}/wp-json/wp/v2/posts`, {
      params,
      timeout: 20000,
      headers: getHeaders(baseUrl, auth, isBridge ? site.bridge_key : null),
    });

    const posts = response.data || [];

    // Pagination si plus de 100 posts
    const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);
    if (totalPages > 1) {
      const extraPages = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          axios.get(`${baseUrl}/wp-json/wp/v2/posts`, {
            params: { ...params, page: i + 2 },
            timeout: 20000,
            headers: getHeaders(baseUrl, auth, isBridge ? site.bridge_key : null),
          }).then(r => r.data || []).catch(() => [])
        )
      );
      posts.push(...extraPages.flat());
    }

    return posts.map(p => ({
      wpPostId: p.id,
      title: p.title?.rendered || '',
      slug: p.slug || '',
      link: p.link || '',
      status: p.status,
      postDate: p.date,
    }));
  } catch (err) {
    console.warn(`  ⚠️ [${site.name}] Fetch échoué : ${err.message}`);
    return [];
  }
}

async function syncSite(site, dataClient, afterDate) {
  console.log(`  🔄 Sync [${site.name}]...`);

  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    try {
      const [encrypted, authTag] = site.wp_password.split(':');
      wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
    } catch {
      console.warn(`  ⚠️ [${site.name}] Déchiffrement échoué — site ignoré.`);
      return;
    }
  }

  const posts = await fetchSitePosts({ ...site, wp_password: wpPassword }, afterDate);

  if (posts.length === 0) {
    console.log(`  ℹ️ [${site.name}] Aucun post trouvé (ou site inaccessible).`);
    return;
  }

  // Full replace par site : delete + insert
  await dataClient.from('wp_posts_cache').delete().eq('wordpress_site_id', site.id);

  const now = new Date().toISOString();
  const rows = posts.map(p => ({
    user_id: site.user_id,
    wordpress_site_id: site.id,
    wp_post_id: p.wpPostId,
    title: p.title,
    slug: p.slug,
    link: p.link,
    status: p.status,
    post_date: p.postDate,
    synced_at: now,
  }));

  const { error } = await dataClient.from('wp_posts_cache').insert(rows);
  if (error) {
    console.warn(`  ⚠️ [${site.name}] Insert cache échoué : ${error.message}`);
  } else {
    console.log(`  ✅ [${site.name}] ${rows.length} post(s) mis en cache.`);
  }
}

(async () => {
  console.log('📅 Démarrage calendar-sync...');

  if (!process.env.CACHE_DB_URL || !process.env.CACHE_DB_SERVICE_KEY) {
    console.error('❌ CACHE_DB_URL ou CACHE_DB_SERVICE_KEY manquant.');
    process.exit(1);
  }

  const dataClient = createDataClient();

  // Fenêtre : 2 mois en arrière + tout le futur
  const afterDate = new Date();
  afterDate.setMonth(afterDate.getMonth() - 2);
  const afterDateISO = afterDate.toISOString();

  // Récupère tous les sites actifs (tous users)
  const { data: sites, error } = await supabase
    .from('wordpress_sites')
    .select('id, user_id, name, url, wp_user, wp_password, wp_password_iv, connection_mode, bridge_key')
    .eq('status', 'active');

  if (error || !sites?.length) {
    console.log('💤 Aucun site actif trouvé.');
    process.exit(0);
  }

  console.log(`📋 ${sites.length} site(s) à synchroniser.`);

  for (const site of sites) {
    await syncSite(site, dataClient, afterDateISO);
    // Pause pour ne pas marteler les sites WP
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('🏁 Calendar-sync terminé.');
  process.exit(0);
})().catch(err => {
  console.error('💥 Erreur fatale :', err);
  process.exit(1);
});
