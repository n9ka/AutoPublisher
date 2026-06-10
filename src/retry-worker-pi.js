require('dotenv').config();
const { getWorkerConfig, runLoop } = require('./lib/retry-worker-runtime');
const { sendDiscordWebhook } = require('./lib/discord');

function applyPiDefaults() {
  if (!process.env.RETRY_WORKER_RUNTIME_LABEL) process.env.RETRY_WORKER_RUNTIME_LABEL = 'pi';
  if (!process.env.RETRY_WORKER_POLL_MS) process.env.RETRY_WORKER_POLL_MS = '60000';
  if (!process.env.RETRY_WORKER_BATCH_SIZE) process.env.RETRY_WORKER_BATCH_SIZE = '2';
  if (!process.env.RETRY_WORKER_MAX_ATTEMPTS) process.env.RETRY_WORKER_MAX_ATTEMPTS = '10';
  if (!process.env.RETRY_WORKER_STATUSES) process.env.RETRY_WORKER_STATUSES = 'failed';
}

async function main() {
  applyPiDefaults();
  const config = getWorkerConfig();
  await runLoop(config);
}

main().catch((error) => {
  const runtimeLabel = process.env.RETRY_WORKER_RUNTIME_LABEL || 'pi';
  console.error(`💥 Retry worker Pi fatal: ${error.message}`);
  sendDiscordWebhook(`Retry worker Pi fatal [${runtimeLabel}] | error=${error.message}`).finally(() => {
    process.exit(1);
  });
});
