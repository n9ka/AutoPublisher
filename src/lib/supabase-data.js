const { createClient } = require('@supabase/supabase-js');

/**
 * Client Supabase secondaire (wp_posts_cache, keywords_database)
 * Utilise la service_role key — ne jamais exposer côté client
 */
function createDataClient() {
  const url = process.env.CACHE_DB_URL;
  const key = process.env.CACHE_DB_SERVICE_KEY;
  if (!url || !key) return null;
  return createClient(url, key);
}

/**
 * Upsert un article publié dans wp_posts_cache
 * Appelé après chaque publication AutoPublisher pour que les badges doublons restent à jour
 */
async function upsertToWpCache({ userId, wordpressSiteId, wpPostId, title, slug, link, status }) {
  const client = createDataClient();
  if (!client) {
    console.warn('  [wp-cache] CACHE_DB_URL ou CACHE_DB_SERVICE_KEY manquant — sync ignorée.');
    return;
  }

  const now = new Date().toISOString();

  // Stratégie delete+insert (même approche que syncWordPressPosts côté frontend)
  await client
    .from('wp_posts_cache')
    .delete()
    .eq('wordpress_site_id', wordpressSiteId)
    .eq('wp_post_id', wpPostId);

  const { error } = await client
    .from('wp_posts_cache')
    .insert({
      user_id: userId,
      wordpress_site_id: wordpressSiteId,
      wp_post_id: wpPostId,
      title,
      slug,
      link,
      status: status || 'draft',
      synced_at: now,
    });

  if (error) {
    console.warn(`  [wp-cache] Sync cache échouée (non bloquant) : ${error.message}`);
  } else {
    console.log(`  [wp-cache] Cache mis à jour pour le post WP #${wpPostId}`);
  }
}

module.exports = { upsertToWpCache };
