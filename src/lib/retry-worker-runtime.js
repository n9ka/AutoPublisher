require('dotenv').config();
const { isPublishCacheEnabled, claimNextRow, retryOneRow } = require('./publish-retry-service');
const { sendDiscordWebhook } = require('./discord');

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

function getWorkerConfig(overrides = {}) {
  return {
    pollMs: parsePositiveInt(overrides.pollMs ?? process.env.RETRY_WORKER_POLL_MS, 60000),
    batchSize: parsePositiveInt(overrides.batchSize ?? process.env.RETRY_WORKER_BATCH_SIZE, 3),
    maxAttempts: parsePositiveInt(overrides.maxAttempts ?? process.env.RETRY_WORKER_MAX_ATTEMPTS, 10),
    siteUrls: overrides.siteUrls ?? parseCsvEnv('RETRY_WORKER_SITE_URLS'),
    sourceKinds: overrides.sourceKinds ?? parseCsvEnv('RETRY_WORKER_SOURCE_KINDS'),
    statuses: overrides.statuses ?? parseCsvEnv('RETRY_WORKER_STATUSES') ?? ['failed'],
    runtimeLabel: overrides.runtimeLabel || process.env.RETRY_WORKER_RUNTIME_LABEL || 'default',
  };
}

async function processBatch(config, logger = console) {
  const summary = {
    claimed: 0,
    published: 0,
    failed: 0,
    publishedLinks: [],
  };

  while (summary.claimed < config.batchSize) {
    const row = await claimNextRow({
      statuses: config.statuses,
      siteUrls: config.siteUrls,
      sourceKinds: config.sourceKinds,
      maxAttempts: config.maxAttempts,
    });

    if (!row) break;

    summary.claimed += 1;
    logger.log(`📥 Job claimé | job=${row.job_id} | site=${row.site_name || row.site_url} | type=${row.source_kind}`);

    try {
      const result = await retryOneRow(row, logger);
      summary.published += 1;
      if (result?.link) {
        summary.publishedLinks.push(result.link);
      }
    } catch (_) {
      summary.failed += 1;
    }
  }

  return summary;
}

function printWorkerBanner(config, logger = console) {
  logger.log(`🚀 Publish Retry Worker démarré [${config.runtimeLabel}]`);
  logger.log(`   poll=${config.pollMs}ms | batch=${config.batchSize} | maxAttempts=${config.maxAttempts}`);
  if (config.siteUrls) logger.log(`   filtres sites=${config.siteUrls.join(', ')}`);
  if (config.sourceKinds) logger.log(`   filtres types=${config.sourceKinds.join(', ')}`);
  if (config.statuses) logger.log(`   statuts=${config.statuses.join(', ')}`);
}

async function runLoop(config, logger = console) {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  printWorkerBanner(config, logger);
  await sendDiscordWebhook(
    [
      `Retry worker Pi demarre [${config.runtimeLabel}]`,
      `poll=${config.pollMs}ms`,
      `batch=${config.batchSize}`,
      `maxAttempts=${config.maxAttempts}`,
      `statuts=${config.statuses.join(',')}`,
    ].join(' | ')
  );

  while (true) {
    const startedAt = Date.now();
    const summary = await processBatch(config, logger);
    const durationMs = Date.now() - startedAt;

    if (summary.claimed === 0) {
      logger.log(`💤 Aucun job à reprendre. Pause ${config.pollMs}ms.`);
    } else {
      logger.log(
        `✅ Batch terminé [${config.runtimeLabel}] : claimed=${summary.claimed} | ` +
        `published=${summary.published} | failed=${summary.failed} | duration=${durationMs}ms. ` +
        `Pause ${config.pollMs}ms.`
      );
      if (summary.publishedLinks.length > 0) {
        logger.log(`🔗 URLs publiées [${config.runtimeLabel}] : ${summary.publishedLinks.join(' | ')}`);
      }
      await sendDiscordWebhook(
        [
          `Retry batch [${config.runtimeLabel}]`,
          `claimed=${summary.claimed}`,
          `published=${summary.published}`,
          `failed=${summary.failed}`,
          `duration=${durationMs}ms`,
          summary.publishedLinks.length > 0 ? `urls=${summary.publishedLinks.join(' , ')}` : null,
        ].filter(Boolean).join(' | ')
      );
    }

    await sleep(config.pollMs);
  }
}

module.exports = {
  getWorkerConfig,
  processBatch,
  runLoop,
  printWorkerBanner,
};
