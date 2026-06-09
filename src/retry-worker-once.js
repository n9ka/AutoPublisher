require('dotenv').config();
const { isPublishCacheEnabled } = require('./lib/publish-retry-service');
const { getWorkerConfig, processBatch, printWorkerBanner } = require('./lib/retry-worker-runtime');

async function main() {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const config = getWorkerConfig({
    runtimeLabel: process.env.RETRY_WORKER_RUNTIME_LABEL || 'once',
  });

  printWorkerBanner(config);
  const startedAt = Date.now();
  const summary = await processBatch(config);
  const durationMs = Date.now() - startedAt;

  console.log(
    `🏁 Batch unique terminé [${config.runtimeLabel}] : claimed=${summary.claimed} | ` +
    `published=${summary.published} | failed=${summary.failed} | duration=${durationMs}ms.`
  );
}

main().catch((error) => {
  console.error(`💥 Retry worker once fatal: ${error.message}`);
  process.exit(1);
});
