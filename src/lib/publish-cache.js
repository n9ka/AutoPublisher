const { Pool } = require('pg');

let pool = null;

function isPublishCacheEnabled() {
  const url = process.env.PUBLISH_CACHE_DATABASE_URL;
  const enabled = (process.env.PUBLISH_CACHE_ENABLED || 'true').trim().toLowerCase();
  return !!url && enabled !== 'false' && enabled !== '0' && enabled !== 'no';
}

function getPool() {
  if (!isPublishCacheEnabled()) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.PUBLISH_CACHE_DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
      max: 3,
    });
  }
  return pool;
}

function sanitizePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

async function savePublishPayload({ jobId, sourceKind, site, payload }) {
  try {
    const db = getPool();
    if (!db) return false;

    const query = `
      insert into publish_retry_cache (
        job_id,
        source_kind,
        wordpress_site_id,
        site_url,
        site_name,
        payload,
        publish_status,
        updated_at
      ) values ($1, $2, $3, $4, $5, $6::jsonb, 'pending', now())
      on conflict (job_id)
      do update set
        source_kind = excluded.source_kind,
        wordpress_site_id = excluded.wordpress_site_id,
        site_url = excluded.site_url,
        site_name = excluded.site_name,
        payload = excluded.payload,
        publish_status = 'pending',
        updated_at = now(),
        last_error = null
    `;

    await db.query(query, [
      jobId,
      sourceKind,
      site.id,
      site.url || site.wp_url,
      site.name || null,
      JSON.stringify(sanitizePayload(payload)),
    ]);

    return true;
  } catch (error) {
    console.warn(`  [publish-cache] sauvegarde ignorée : ${error.message}`);
    return false;
  }
}

async function markPublishFailed(jobId, errorMessage) {
  try {
    const db = getPool();
    if (!db) return false;

    await db.query(
      `
        update publish_retry_cache
        set publish_status = 'failed',
            attempts = attempts + 1,
            last_error = $2,
            updated_at = now()
        where job_id = $1
      `,
      [jobId, errorMessage || null]
    );

    return true;
  } catch (error) {
    console.warn(`  [publish-cache] marquage failed ignoré : ${error.message}`);
    return false;
  }
}

async function markPublishSucceeded(jobId, publishedUrl = null) {
  try {
    const db = getPool();
    if (!db) return false;

    await db.query(
      `
        update publish_retry_cache
        set publish_status = 'published',
            published_url = $2,
            updated_at = now()
        where job_id = $1
      `,
      [jobId, publishedUrl]
    );

    return true;
  } catch (error) {
    console.warn(`  [publish-cache] marquage published ignoré : ${error.message}`);
    return false;
  }
}

async function getPublishPayload(jobId) {
  try {
    const db = getPool();
    if (!db) return null;

    const { rows } = await db.query(
      `
        select *
        from publish_retry_cache
        where job_id = $1
        limit 1
      `,
      [jobId]
    );

    return rows[0] || null;
  } catch (error) {
    console.warn(`[publish-cache] lecture job ignorée : ${error.message}`);
    return null;
  }
}

async function listPublishPayloads({ status = null, limit = 20 } = {}) {
  try {
    const db = getPool();
    if (!db) return [];

    const params = [];
    let where = '';

    if (status) {
      params.push(status);
      where = `where publish_status = $${params.length}`;
    }

    params.push(limit);

    const { rows } = await db.query(
      `
        select *
        from publish_retry_cache
        ${where}
        order by updated_at desc
        limit $${params.length}
      `,
      params
    );

    return rows;
  } catch (error) {
    console.warn(`[publish-cache] listing ignoré : ${error.message}`);
    return [];
  }
}

async function claimNextPublishPayload({ statuses = ['failed'], siteUrls = null, sourceKinds = null, maxAttempts = 10 } = {}) {
  try {
    const db = getPool();
    if (!db) return null;

    const normalizedStatuses = Array.isArray(statuses) && statuses.length > 0 ? statuses : ['failed'];
    const normalizedSiteUrls = Array.isArray(siteUrls) && siteUrls.length > 0 ? siteUrls : null;
    const normalizedSourceKinds = Array.isArray(sourceKinds) && sourceKinds.length > 0 ? sourceKinds : null;

    const { rows } = await db.query(
      `
        with candidate as (
          select id
          from publish_retry_cache
          where publish_status = any($1::text[])
            and attempts < $2
            and expires_at > now()
            and ($3::text[] is null or site_url = any($3::text[]))
            and ($4::text[] is null or source_kind = any($4::text[]))
          order by updated_at asc
          limit 1
          for update skip locked
        )
        update publish_retry_cache prc
        set publish_status = 'retrying',
            updated_at = now()
        from candidate
        where prc.id = candidate.id
        returning prc.*
      `,
      [
        normalizedStatuses,
        maxAttempts,
        normalizedSiteUrls,
        normalizedSourceKinds,
      ]
    );

    return rows[0] || null;
  } catch (error) {
    console.warn(`[publish-cache] claim ignoré : ${error.message}`);
    return null;
  }
}

module.exports = {
  isPublishCacheEnabled,
  savePublishPayload,
  markPublishFailed,
  markPublishSucceeded,
  getPublishPayload,
  listPublishPayloads,
  claimNextPublishPayload,
};
