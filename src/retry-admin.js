require('dotenv').config();
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { isPublishCacheEnabled, listRows, getRowForJob, retryOneRow, loadJob } = require('./lib/publish-retry-service');

function truncate(value, length = 60) {
  if (!value) return '';
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

async function enrichRows(rows) {
  const enriched = [];
  for (const row of rows) {
    let job = null;
    try {
      job = await loadJob(row.job_id);
    } catch (_) {
      // On garde la ligne même si Supabase ne répond pas pour ce job.
    }

    enriched.push({
      ...row,
      job,
      title: row.payload?.title || job?.source_title || '(sans titre)',
      siteName: row.site_name || job?.wordpress_sites?.name || '(site inconnu)',
      sourceType: job?.source_type || row.source_kind,
    });
  }
  return enriched;
}

function printRows(rows) {
  if (rows.length === 0) {
    console.log('\nAucun job trouvé.\n');
    return;
  }

  console.log('\nJobs disponibles :\n');
  rows.forEach((row, index) => {
    const error = truncate(row.last_error || '-', 70);
    console.log(
      `${String(index + 1).padStart(2, ' ')}. [${row.publish_status}] ${truncate(row.siteName, 18).padEnd(18)} ` +
      `| ${truncate(row.sourceType, 9).padEnd(9)} | ${truncate(row.title, 55)}`
    );
    console.log(`    job=${row.job_id} | essais=${row.attempts} | erreur=${error}`);
  });
  console.log('');
}

async function askForSelection(rl, max) {
  const raw = (await rl.question('Sélectionne un index, une liste "1,3,5", "all", ou Entrée pour annuler : ')).trim();
  if (!raw) return [];
  if (raw.toLowerCase() === 'all') {
    return Array.from({ length: max }, (_, i) => i);
  }

  const indices = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10) - 1)
    .filter((value) => Number.isInteger(value) && value >= 0 && value < max);

  return [...new Set(indices)];
}

async function retrySelection(rows, selectedIndexes) {
  for (const index of selectedIndexes) {
    const row = rows[index];
    try {
      await retryOneRow(row);
    } catch (_) {
      // Le moteur a déjà loggé l'erreur, on poursuit.
    }
  }
}

async function inspectJob(rl) {
  const jobId = (await rl.question('Job ID à afficher : ')).trim();
  if (!jobId) return;

  const row = await getRowForJob(jobId);
  if (!row) {
    console.log('Aucun payload Neon trouvé pour ce job.\n');
    return;
  }

  const job = await loadJob(jobId).catch(() => null);
  console.log('\n=== Détail Job ===');
  console.log(JSON.stringify({
    job_id: row.job_id,
    source_kind: row.source_kind,
    publish_status: row.publish_status,
    attempts: row.attempts,
    last_error: row.last_error,
    site_url: row.site_url,
    payload: row.payload,
    source_type: job?.source_type || null,
    site_name: job?.wordpress_sites?.name || row.site_name || null,
  }, null, 2));
  console.log('');
}

async function menuLoop() {
  if (!isPublishCacheEnabled()) {
    throw new Error('Publish cache désactivé ou PUBLISH_CACHE_DATABASE_URL manquante');
  }

  const rl = readline.createInterface({ input, output });

  try {
    let status = 'failed';
    let limit = 25;

    while (true) {
      console.log('=== Publish Retry Admin ===');
      console.log(`1. Lister les jobs (${status}, limite ${limit})`);
      console.log('2. Republier un ou plusieurs jobs');
      console.log('3. Republier tous les jobs listés');
      console.log('4. Voir le détail d’un job');
      console.log('5. Changer le statut (failed/pending/published)');
      console.log('6. Changer la limite');
      console.log('0. Quitter');

      const choice = (await rl.question('Choix : ')).trim();
      console.log('');

      if (choice === '0') break;

      if (choice === '5') {
        const nextStatus = (await rl.question('Statut à lister (failed/pending/published) : ')).trim().toLowerCase();
        if (['failed', 'pending', 'published'].includes(nextStatus)) {
          status = nextStatus;
        } else {
          console.log('Statut invalide.\n');
        }
        continue;
      }

      if (choice === '6') {
        const nextLimit = Number.parseInt((await rl.question('Nouvelle limite : ')).trim(), 10);
        if (Number.isInteger(nextLimit) && nextLimit > 0) {
          limit = nextLimit;
        } else {
          console.log('Limite invalide.\n');
        }
        continue;
      }

      if (choice === '4') {
        await inspectJob(rl);
        continue;
      }

      const rows = await enrichRows(await listRows({ status, limit }));
      printRows(rows);

      if (rows.length === 0) continue;

      if (choice === '1') {
        continue;
      }

      if (choice === '2') {
        const selectedIndexes = await askForSelection(rl, rows.length);
        if (selectedIndexes.length === 0) {
          console.log('Aucune sélection.\n');
          continue;
        }
        await retrySelection(rows, selectedIndexes);
        console.log('');
        continue;
      }

      if (choice === '3') {
        await retrySelection(rows, rows.map((_, index) => index));
        console.log('');
        continue;
      }

      console.log('Choix invalide.\n');
    }
  } finally {
    rl.close();
  }
}

menuLoop().catch((error) => {
  console.error(`💥 Retry admin fatal: ${error.message}`);
  process.exit(1);
});
