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
    });
  }
  return pool;
}

function sanitizePayload(payload) {
  return JSON.parse(JSON.stringify(payload));
}

async function savePublishPayload({ jobId, sourceKind, site, payload }) {
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
}

async function markPublishFailed(jobId, errorMessage) {
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
}

async function markPublishSucceeded(jobId, publishedUrl = null) {
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
}

module.exports = {
  isPublishCacheEnabled,
  savePublishPayload,
  markPublishFailed,
  markPublishSucceeded,
};
