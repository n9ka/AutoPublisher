require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { decrypt } = require('./lib/encryption');
const { publishPost } = require('./lib/wordpress');
const { enqueueSocialPost } = require('./lib/social/enqueue');
const { upsertToWpCache } = require('./lib/supabase-data');
const { getPublishPayload, listPublishPayloads, markPublishFailed, markPublishSucceeded, isPublishCacheEnabled } = require('./lib/publish-cache');
const { spendCredit, refundCredit } = require('./lib/credits');

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function loadJob(jobId) {
  const { data, error } = await supabase
    .from('articles_queue')
    .select('*, wordpress_sites(*)')
    .eq('id', jobId)
    .single();

  if (error || !data) {
    throw new Error(`Job introuvable dans Supabase: ${jobId}`);
  }

  return data;
}

function getWpPassword(site) {
  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY manquante dans l’environnement.');
    }
    const [encrypted, authTag] = site.wp_password.split(':');
    wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
  }
  return wpPassword;
}

async function applySuccessEffects(sourceKind, job, site, payload, pubResult) {
  const jobId = job.id;
  const publishedAt = new Date();

  if (sourceKind === 'processor') {
    await supabase.from('processed_articles').insert({
      wordpress_site_id: site.id,
      source_url: job.source_url,
      source_title: job.source_title,
      embedding: job.embedding,
      wordpress_post_id: pubResult.id,
      wordpress_url: pubResult.link,
      category_id: Array.isArray(payload.categories) ? payload.categories[0] : null,
    });

    await supabase
      .from('articles_queue')
      .update({
        status: 'published',
        processed_at: publishedAt,
        published_title: payload.title,
        published_url: pubResult.link,
        error_message: null,
      })
      .eq('id', jobId);

    await enqueueSocialPost(site.id, jobId, job.source_type, job.scheduled_at);

    if (pubResult.id) {
      await upsertToWpCache({
        userId: site.user_id,
        wordpressSiteId: site.id,
        wpPostId: pubResult.id,
        title: payload.title,
        slug: payload.slug,
        link: pubResult.link,
        status: site.default_status || 'publish',
        postDate: publishedAt.toISOString(),
      });
    }

    return;
  }

  if (sourceKind === 'manual' || sourceKind === 'custom') {
    await supabase
      .from('articles_queue')
      .update({
        status: 'published',
        processed_at: publishedAt,
        published_title: payload.title,
        published_url: pubResult.link,
        error_message: null,
      })
      .eq('id', jobId);

    await enqueueSocialPost(site.id, jobId, 'seo', job.scheduled_at);

    if (pubResult.id) {
      await upsertToWpCache({
        userId: site.user_id,
        wordpressSiteId: site.id,
        wpPostId: pubResult.id,
        title: payload.title,
        slug: payload.slug,
        link: pubResult.link,
        status: job.custom_status || site.default_status || 'draft',
        postDate: job.scheduled_at || publishedAt.toISOString(),
      });
    }

    return;
  }

  throw new Error(`sourceKind non géré pour le retry: ${sourceKind}`);
}

async function retryOne(row) {
  const job = await loadJob(row.job_id);
  const site = job.wordpress_sites;
  const wpPassword = getWpPassword(site);
  const payload = row.payload;
  const retryMeta = payload._retry_meta || {};
  const creditsToCharge = Number(retryMeta.credits_to_charge || 0);
  const publishPayload = { ...payload };
  delete publishPayload._retry_meta;

  console.log(`🚀 Retry ${row.source_kind} | job=${row.job_id} | site=${site.name}`);

  try {
    if (creditsToCharge > 0) {
      await spendCredit(site.user_id, creditsToCharge, row.job_id);
      console.log(`💳 Retry: ${creditsToCharge} crédit(s) re-débités.`);
    }

    const pubResult = await publishPost({ ...site, wp_password: wpPassword }, publishPayload);
    await applySuccessEffects(row.source_kind, job, site, publishPayload, pubResult);
    await markPublishSucceeded(row.job_id, pubResult.link);

    if (retryMeta.request_indexing) {
      // TODO: Rejouer aussi l'indexation custom ici si request_indexing=true.
      console.warn('⚠️ TODO: indexation custom non rejouée automatiquement lors du retry local.');
    }

    console.log(`✅ Retry publié : ${pubResult.link}`);
  } catch (error) {
    if (creditsToCharge > 0) {
      try {
        await refundCredit(site.user_id, creditsToCharge, row.job_id);
        console.log(`💰 Retry: ${creditsToCharge} crédit(s) remboursés après nouvel échec.`);
      } catch (refundError) {
        console.error(`⚠️ Retry: échec du remboursement après erreur de publication: ${refundError.message}`);
      }
    }
    await markPublishFailed(row.job_id, error.message);
    console.error(`❌ Retry échoué | job=${row.job_id} | ${error.message}`);
    throw error;
  }
}

async function main() {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const jobId = getArg('--job');
  const retryAllFailed = hasFlag('--all-failed');
  const limit = Number.parseInt(getArg('--limit') || '10', 10);

  if (jobId) {
    const row = await getPublishPayload(jobId);
    if (!row) throw new Error(`Aucun payload Neon trouvé pour job ${jobId}`);
    await retryOne(row);
    return;
  }

  if (retryAllFailed) {
    const rows = await listPublishPayloads({ status: 'failed', limit });
    if (rows.length === 0) {
      console.log('ℹ️ Aucun payload failed à republier.');
      return;
    }

    for (const row of rows) {
      try {
        await retryOne(row);
      } catch (_) {
        // On continue pour les autres jobs.
      }
    }
    return;
  }

  console.log('Usage:');
  console.log('  node src/retry-publish-cache.js --job <job_id>');
  console.log('  node src/retry-publish-cache.js --all-failed [--limit 10]');
}

main().catch((error) => {
  console.error(`💥 Retry publish cache fatal: ${error.message}`);
  process.exit(1);
});
