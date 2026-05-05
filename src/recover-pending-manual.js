// recover-pending-manual.js — Relance les jobs manual bloqués en pending
// Usage: node src/recover-pending-manual.js [--dry-run]
require('dotenv').config();
const { supabase } = require('./lib/supabase');
const axios = require('axios');

const DRY_RUN = process.argv.includes('--dry-run');
const MAX_AGE_MINUTES = parseInt(process.env.RECOVER_MAX_AGE_MINUTES || '30', 10);

async function recover() {
  console.log(`🔧 Recovery pending manual jobs (>= ${MAX_AGE_MINUTES}min, dry-run=${DRY_RUN})`);

  const cutoff = new Date(Date.now() - MAX_AGE_MINUTES * 60 * 1000).toISOString();

  const { data: jobs, error } = await supabase
    .from('articles_queue')
    .select('id, source_title, generation_mode, created_at, wordpress_site_id')
    .eq('status', 'pending')
    .eq('source_type', 'manual')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true });

  if (error) {
    console.error('❌ Erreur Supabase:', error.message);
    process.exit(1);
  }

  if (!jobs || jobs.length === 0) {
    console.log('✅ Aucun job bloqué trouvé.');
    return;
  }

  console.log(`📋 ${jobs.length} job(s) bloqué(s) trouvé(s) :`);
  for (const job of jobs) {
    const ageMin = Math.round((Date.now() - new Date(job.created_at)) / 60000);
    console.log(`  - [${job.id}] "${job.source_title}" mode=${job.generation_mode} age=${ageMin}min`);
  }

  if (DRY_RUN) {
    console.log('\n⚠️  Mode dry-run — aucune action effectuée.');
    return;
  }

  const githubToken = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPO;

  if (!githubToken || !repo) {
    console.error('❌ GH_PAT ou GITHUB_REPO manquants — impossible de redispatcher.');
    console.log('   Marquez ces jobs en failed manuellement ou configurez les variables.');
    process.exit(1);
  }

  let ok = 0, fail = 0;
  for (const job of jobs) {
    const workflowFile = job.generation_mode === 'custom' ? 'custom-generator.yml' : 'manual-generator.yml';
    try {
      await axios.post(
        `https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`,
        { ref: 'main', inputs: { job_id: String(job.id) } },
        {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28'
          }
        }
      );
      console.log(`  ✅ [${job.id}] Redispatch OK → ${workflowFile}`);
      ok++;
    } catch (ghErr) {
      const statusCode = ghErr.response?.status;
      console.error(`  ❌ [${job.id}] Dispatch failed (${statusCode || ghErr.message})`);
      if (statusCode === 404) {
        console.error(`     → Workflow "${workflowFile}" introuvable dans ${repo}`);
      }
      fail++;
    }
  }

  console.log(`\n🏁 Terminé : ${ok} redispatch(s) OK, ${fail} échec(s).`);
  if (fail > 0) {
    console.log('   Pour marquer les jobs échoués en "failed" : relancez avec --mark-failed (non implémenté ici, faire via Supabase Dashboard).');
  }
}

recover().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
