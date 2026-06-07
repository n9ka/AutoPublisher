require('dotenv').config();
const { supabase } = require('./supabase');
const { decrypt } = require('./encryption');
const { publishPost, uploadImageToWordPress } = require('./wordpress');
const { enqueueSocialPost } = require('./social/enqueue');
const { upsertToWpCache } = require('./supabase-data');
const { getPublishPayload, listPublishPayloads, markPublishFailed, markPublishSucceeded, isPublishCacheEnabled } = require('./publish-cache');
const { spendCredit, refundCredit } = require('./credits');

function getSiteBaseUrl(site) {
  return (site.url || site.wp_url || '').replace(/\/$/, '');
}

function isSameHost(urlA, urlB) {
  if (!urlA || !urlB) return false;
  try {
    return new URL(urlA).host === new URL(urlB).host;
  } catch {
    return false;
  }
}

function replaceAllOccurrences(content, from, to) {
  if (!content || !from || !to || from === to) return content;
  return content.split(from).join(to);
}

async function tryUploadRetryMedia(site, wpPassword, imageUrl, altText, label, logger = console) {
  if (!imageUrl) return null;

  try {
    const media = await uploadImageToWordPress(
      site.url,
      site.wp_user,
      wpPassword,
      imageUrl,
      altText,
      site.connection_mode,
      site.bridge_key
    );

    if (media?.id || media?.url) {
      logger.log(`🖼️ Retry: ${label} réuploadé${media.id ? ` (media_id=${media.id})` : ''}.`);
      return media;
    }

    logger.warn(`⚠️ Retry: ${label} non réuploadé, conservation de l'URL existante.`);
    return null;
  } catch (error) {
    logger.warn(`⚠️ Retry: échec réupload ${label}: ${error.message}`);
    return null;
  }
}

async function rehydratePublishPayload(site, job, publishPayload, wpPassword, logger = console) {
  const hydratedPayload = {
    ...publishPayload,
    content: publishPayload.content || '',
  };
  const siteBaseUrl = getSiteBaseUrl(site);

  if (!hydratedPayload.featured_media_id && hydratedPayload.featured_media_url) {
    const featuredAlt = hydratedPayload.featured_media_alt || hydratedPayload.title || job.source_title || 'Featured image';
    const featuredMedia = await tryUploadRetryMedia(
      site,
      wpPassword,
      hydratedPayload.featured_media_url,
      featuredAlt,
      'image de couverture',
      logger
    );

    if (featuredMedia?.id) {
      hydratedPayload.featured_media_id = featuredMedia.id;
      hydratedPayload.featured_media_url = featuredMedia.url || hydratedPayload.featured_media_url;
    }
  }

  if (hydratedPayload.infographic_url && !isSameHost(hydratedPayload.infographic_url, siteBaseUrl)) {
    const infographicAlt = hydratedPayload.infographic_alt || hydratedPayload.title || job.source_title || 'Infographic';
    const infographicMedia = await tryUploadRetryMedia(
      site,
      wpPassword,
      hydratedPayload.infographic_url,
      infographicAlt,
      'infographie',
      logger
    );

    if (infographicMedia?.url) {
      hydratedPayload.content = replaceAllOccurrences(
        hydratedPayload.content,
        hydratedPayload.infographic_url,
        infographicMedia.url
      );
      hydratedPayload.infographic_url = infographicMedia.url;
    }
  }

  if (Array.isArray(hydratedPayload.section_image_urls) && hydratedPayload.section_image_urls.length > 0) {
    const updatedSectionImages = [];

    for (const entry of hydratedPayload.section_image_urls) {
      const originalUrl = typeof entry === 'string' ? entry : entry?.url;
      const altText = typeof entry === 'string' ? '' : (entry?.alt || '');

      if (!originalUrl) continue;

      if (isSameHost(originalUrl, siteBaseUrl)) {
        updatedSectionImages.push(typeof entry === 'string' ? originalUrl : { ...entry, url: originalUrl });
        continue;
      }

      const uploadedMedia = await tryUploadRetryMedia(
        site,
        wpPassword,
        originalUrl,
        altText || hydratedPayload.title || job.source_title || 'Section image',
        'image de section',
        logger
      );

      if (uploadedMedia?.url) {
        hydratedPayload.content = replaceAllOccurrences(
          hydratedPayload.content,
          originalUrl,
          uploadedMedia.url
        );
        updatedSectionImages.push(
          typeof entry === 'string'
            ? uploadedMedia.url
            : { ...entry, url: uploadedMedia.url }
        );
      } else {
        updatedSectionImages.push(entry);
      }
    }

    hydratedPayload.section_image_urls = updatedSectionImages;
  }

  return hydratedPayload;
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

async function retryOneRow(row, logger = console) {
  const job = await loadJob(row.job_id);
  const site = job.wordpress_sites;
  const wpPassword = getWpPassword(site);
  const payload = row.payload;
  const retryMeta = payload._retry_meta || {};
  const creditsToCharge = Number(retryMeta.credits_to_charge || 0);
  const publishPayload = { ...payload };
  delete publishPayload._retry_meta;

  logger.log(`🚀 Retry ${row.source_kind} | job=${row.job_id} | site=${site.name}`);

  try {
    if (creditsToCharge > 0) {
      await spendCredit(site.user_id, creditsToCharge, row.job_id);
      logger.log(`💳 Retry: ${creditsToCharge} crédit(s) re-débités.`);
    }

    const hydratedPayload = await rehydratePublishPayload(site, job, publishPayload, wpPassword, logger);
    const pubResult = await publishPost({ ...site, wp_password: wpPassword }, hydratedPayload);
    await applySuccessEffects(row.source_kind, job, site, hydratedPayload, pubResult);
    await markPublishSucceeded(row.job_id, pubResult.link);

    if (retryMeta.request_indexing) {
      logger.warn('⚠️ TODO: indexation custom non rejouée automatiquement lors du retry local.');
    }

    logger.log(`✅ Retry publié : ${pubResult.link}`);
    return { ok: true, link: pubResult.link, row };
  } catch (error) {
    if (creditsToCharge > 0) {
      try {
        await refundCredit(site.user_id, creditsToCharge, row.job_id);
        logger.log(`💰 Retry: ${creditsToCharge} crédit(s) remboursés après nouvel échec.`);
      } catch (refundError) {
        logger.error(`⚠️ Retry: échec du remboursement après erreur de publication: ${refundError.message}`);
      }
    }
    await markPublishFailed(row.job_id, error.message);
    logger.error(`❌ Retry échoué | job=${row.job_id} | ${error.message}`);
    throw error;
  }
}

async function getRowForJob(jobId) {
  return getPublishPayload(jobId);
}

async function listRows({ status = 'failed', limit = 25 } = {}) {
  return listPublishPayloads({ status, limit });
}

module.exports = {
  isPublishCacheEnabled,
  getRowForJob,
  listRows,
  retryOneRow,
  loadJob,
};
