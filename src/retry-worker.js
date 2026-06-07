require('dotenv').config();
const { isPublishCacheEnabled, claimNextRow, retryOneRow } = require('./lib/publish-retry-service');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseCsvEnv(name) {
  const value = (process.env[name] || '').trim();
  if (!value) return null;
  const items = value.split(',').map((item) => item.trim()).filter(Boolean);
  return items.length > 0 ? items : null;
}

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getWorkerConfig() {
  return {
    pollMs: parsePositiveInt(process.env.RETRY_WORKER_POLL_MS, 60000),
    batchSize: parsePositiveInt(process.env.RETRY_WORKER_BATCH_SIZE, 3),
    maxAttempts: parsePositiveInt(process.env.RETRY_WORKER_MAX_ATTEMPTS, 10),
    siteUrls: parseCsvEnv('RETRY_WORKER_SITE_URLS'),
    sourceKinds: parseCsvEnv('RETRY_WORKER_SOURCE_KINDS'),
    statuses: parseCsvEnv('RETRY_WORKER_STATUSES') || ['failed'],
  };
}

async function processBatch(config) {
  let processed = 0;

  while (processed < config.batchSize) {
    const row = await claimNextRow({
      statuses: config.statuses,
      siteUrls: config.siteUrls,
      sourceKinds: config.sourceKinds,
      maxAttempts: config.maxAttempts,
    });

    if (!row) break;

    console.log(`📥 Job claimé | job=${row.job_id} | site=${row.site_name || row.site_url} | type=${row.source_kind}`);

    try {
      await retryOneRow(row);
    } catch (_) {
      // Le moteur a déjà loggé l'erreur et remis le job en failed.
    }

    processed += 1;
  }

  return processed;
}

async function main() {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const config = getWorkerConfig();

  console.log('🚀 Publish Retry Worker démarré');
  console.log(`   poll=${config.pollMs}ms | batch=${config.batchSize} | maxAttempts=${config.maxAttempts}`);
  if (config.siteUrls) console.log(`   filtres sites=${config.siteUrls.join(', ')}`);
  if (config.sourceKinds) console.log(`   filtres types=${config.sourceKinds.join(', ')}`);
  if (config.statuses) console.log(`   statuts=${config.statuses.join(', ')}`);

  while (true) {
    const processed = await processBatch(config);

    if (processed === 0) {
      console.log(`💤 Aucun job à reprendre. Pause ${config.pollMs}ms.`);
    } else {
      console.log(`✅ Batch terminé : ${processed} job(s) traité(s). Pause ${config.pollMs}ms.`);
    }

    await sleep(config.pollMs);
  }
}

main().catch((error) => {
  console.error(`💥 Retry worker fatal: ${error.message}`);
  process.exit(1);
});
