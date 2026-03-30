const { supabase } = require('../supabase');

/**
 * Insère un job dans social_queue si le trigger social est activé pour ce site/source_type
 * @param {string} siteId
 * @param {string} articleId
 * @param {'rss'|'trend'|'seo'|'manual'} sourceType
 * @param {string|null} scheduledAt - datetime ISO de publication WP (pour articles planifiés)
 */
async function enqueueSocialPost(siteId, articleId, sourceType, scheduledAt = null) {
  const triggerCol = `trigger_${sourceType}`;

  const { data: config } = await supabase
    .from('site_social_config')
    .select('id, posting_enabled')
    .eq('site_id', siteId)
    .eq(triggerCol, true)
    .eq('posting_enabled', true)
    .maybeSingle();

  if (!config) return;

  await supabase.from('social_queue').insert({
    site_id: siteId,
    article_id: articleId,
    source_type: sourceType,
    status: 'pending',
    scheduled_at: scheduledAt || new Date().toISOString(),
  });

  console.log(`  📱 Post social mis en queue (${sourceType})${scheduledAt ? ` — planifié à ${scheduledAt}` : ''}`);
}

module.exports = { enqueueSocialPost };
