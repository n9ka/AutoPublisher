require('dotenv').config();
const { isPublishCacheEnabled, getRowForJob, listRows, retryOneRow } = require('./lib/publish-retry-service');

function getArg(name) {
  const index = process.argv.indexOf(name);
  return index !== -1 ? process.argv[index + 1] : null;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

async function main() {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const jobId = getArg('--job');
  const retryAllFailed = hasFlag('--all-failed');
  const limit = Number.parseInt(getArg('--limit') || '10', 10);

  if (jobId) {
    const row = await getRowForJob(jobId);
    if (!row) throw new Error(`Aucun payload Neon trouvé pour job ${jobId}`);
    await retryOneRow(row);
    return;
  }

  if (retryAllFailed) {
    const rows = await listRows({ status: 'failed', limit });
    if (rows.length === 0) {
      console.log('ℹ️ Aucun payload failed à republier.');
      return;
    }

    for (const row of rows) {
      try {
        await retryOneRow(row);
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
