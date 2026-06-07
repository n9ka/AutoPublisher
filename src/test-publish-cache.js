require('dotenv').config();
const { Pool } = require('pg');

async function main() {
  const connectionString = process.env.PUBLISH_CACHE_DATABASE_URL;
  if (!connectionString) {
    throw new Error('PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false },
  });

  const client = await pool.connect();

  try {
    const testJobId = '00000000-0000-0000-0000-000000000001';
    const payload = {
      title: 'Test publish cache',
      content: '<p>Test payload</p>',
      slug: 'test-publish-cache',
      created_by: 'github-actions',
    };

    console.log('🔌 Connexion Neon OK');

    await client.query(
      `
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
          payload = excluded.payload,
          updated_at = now(),
          publish_status = 'pending',
          last_error = null
      `,
      [
        testJobId,
        'test',
        testJobId,
        'https://example.com',
        'Test Site',
        JSON.stringify(payload),
      ]
    );

    console.log('✅ Insert / upsert OK');

    const { rows } = await client.query(
      `
        select job_id, source_kind, site_url, publish_status, created_at, updated_at
        from publish_retry_cache
        where job_id = $1
        limit 1
      `,
      [testJobId]
    );

    console.log('📦 Ligne récupérée :');
    console.log(JSON.stringify(rows[0], null, 2));
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error('❌ Test publish cache échoué:', error.message);
  process.exit(1);
});
