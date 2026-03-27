require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { supabase } = require('./lib/supabase');
const { decrypt } = require('./lib/encryption');
const { getSitePostsForCalendar } = require('./lib/wordpress');

function createDataClient() {
  return createClient(process.env.CACHE_DB_URL, process.env.CACHE_DB_SERVICE_KEY);
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

  let posts;
  try {
    posts = await getSitePostsForCalendar({ ...site, wp_password: wpPassword }, afterDate);
  } catch (err) {
    console.warn(`  ⚠️ [${site.name}] Fetch échoué : ${err.message}`);
    console.log(`  ℹ️ [${site.name}] Aucun post trouvé (ou site inaccessible).`);
    return;
  }

  if (!posts.length) {
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

  const { data: sites, error } = await supabase
    .from('wordpress_sites')
    .select('id, user_id, name, url, wp_user, wp_password, wp_password_iv, connection_mode, bridge_key')
    .eq('active', true);

  if (error) {
    console.error(`❌ Erreur Supabase : ${error.message} (code: ${error.code})`);
    process.exit(1);
  }
  if (!sites?.length) {
    console.log('💤 Aucun site actif trouvé.');
    process.exit(0);
  }

  console.log(`📋 ${sites.length} site(s) à synchroniser.`);

  for (const site of sites) {
    await syncSite(site, dataClient, afterDateISO);
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('🏁 Calendar-sync terminé.');
  process.exit(0);
})().catch(err => {
  console.error('💥 Erreur fatale :', err);
  process.exit(1);
});
