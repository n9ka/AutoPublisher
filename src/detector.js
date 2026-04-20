require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { fetchRSS } = require('./lib/rss');
const { getEmbedding, filterBestArticlesBatch, getStats, resetStats } = require('./lib/gemini');
const { hasEnoughCredits } = require('./lib/credits');
const { sendTelegram } = require('./lib/telegram');

// Configuration
const DAY_IN_MS = 24 * 60 * 60 * 1000;
const RSS_SEMANTIC_MATCH_THRESHOLD = parseFloat(process.env.RSS_SEMANTIC_MATCH_THRESHOLD || '0.78');

/**
 * Gère la planification automatique des articles SEO à partir du backlog (AutoPilot 2.0)
 */
async function checkAutoSeo(site) {
  // 1. Vérifier si activé
  const quota = site.auto_seo_weekly_quota || 0;
  const isEnabled = site.auto_seo_enabled || false;
  if (!isEnabled || quota <= 0) return false;

  // 1b. Vérifier la plage de dates si définie
  if (site.auto_seo_start_date && site.auto_seo_end_date) {
    const now = new Date();
    const start = new Date(site.auto_seo_start_date);
    const end = new Date(site.auto_seo_end_date);
    end.setHours(23, 59, 59, 999); // inclusif sur le jour de fin

    if (now < start) {
      console.log(`  ⏳ AutoPilot : Plage pas encore commencée (début: ${site.auto_seo_start_date}).`);
      return false;
    }

    if (now > end) {
      console.log(`  🔚 AutoPilot : Plage expirée (fin: ${site.auto_seo_end_date}). Réinitialisation...`);
      await supabase
        .from('wordpress_sites')
        .update({
          auto_seo_enabled: false,
          auto_seo_start_date: null,
          auto_seo_end_date: null,
        })
        .eq('id', site.id);
      return false;
    }
  }

  // 2. Calculer l'intervalle (ex: 3 art/semaine = 56h)
  const intervalHours = (7 * 24) / quota;

  // 3. Vérifier si le délai est respecté
  if (site.last_auto_seo_at) {
    const lastRun = new Date(site.last_auto_seo_at);
    const diffHours = (new Date() - lastRun) / (60 * 60 * 1000);

    if (diffHours < intervalHours) {
      console.log(`  ⏳ AutoPilot : Trop tôt (Dernier run il y a ${diffHours.toFixed(1)}h, intervalle: ${intervalHours.toFixed(1)}h).`);
      return false;
    }
  }

  // 4. Récupérer le prochain mot-clé du backlog
  const { data: backlogItem, error: backlogError } = await supabase
    .from('seo_backlog')
    .select('*')
    .eq('wordpress_site_id', site.id)
    .eq('status', 'pending')
    .neq('generation_mode', 'manual')
    .order('priority', { ascending: false })
    .order('created_at', { ascending: true })
    .limit(1)
    .single();

  if (backlogError || !backlogItem) {
    console.log('  Ø AutoPilot : Backlog de mots-clés vide.');
    return false;
  }

  // 5. Vérifier les crédits selon le mode (Express: 3, Expert: 5, Custom: variable)
  const mode = backlogItem.generation_mode || site.auto_seo_mode || 'express';
  let cost;
  if (mode === 'custom') {
    const opts = backlogItem.custom_options || site.auto_custom_config;
    if (!opts || !opts.brief_model_id || !opts.model_id) {
      console.log(`  ⚠️  AutoPilot : Mode Personnalisé non configuré pour "${backlogItem.keyword}". Configurez le mode dans l'onglet Configuration du SEO Lab.`);
      return false;
    }
    const briefCredits = opts?.brief_credits || 2;
    const writingCredits = opts?.writing_credits || 4;
    cost = 1 + briefCredits + writingCredits;
  } else {
    cost = mode === 'expert' ? 5 : 3;
  }

  const canAfford = await hasEnoughCredits(site.user_id, cost);
  if (!canAfford) {
    console.log(`  ❌ AutoPilot : Crédits insuffisants pour le mode ${mode} (${cost} requis).`);
    return false;
  }

  console.log(`  🎯 AutoPilot : Activation pour "${backlogItem.keyword}" (${mode.toUpperCase()})`);

  // 6. Ajouter à la file d'attente
  const { data: insertData, error: insertError } = await supabase
    .from('articles_queue')
    .insert({
      wordpress_site_id: site.id,
      source_title: backlogItem.keyword,
      source_type: 'manual',
      generation_mode: mode,
      target_length: backlogItem.target_length || site.auto_seo_target_length || 'medium',
      infographic_model: backlogItem.infographic_model || site.auto_seo_infographic_style || 'banana',
      custom_status: site.auto_seo_status || 'draft',
      custom_options: backlogItem.custom_options || site.auto_custom_config || null,
      status: 'pending',
      created_at: new Date()
    })
    .select();

  if (insertError) {
    console.error('  ❌ AutoPilot : Erreur insertion queue:', insertError.message);
    return false;
  }

  const newJobId = insertData[0].id;

  // 7. Déclencher le workflow GitHub pour la génération immédiate
  const githubToken = process.env.GH_PAT;
  const repo = process.env.GITHUB_REPO;

  if (githubToken && repo) {
    try {
      console.log(`  🚀 AutoPilot : Déclenchement du workflow GitHub pour le job ${newJobId}...`);
      const axios = require('axios');
      const workflowFile = mode === 'custom' ? 'custom-generator.yml' : 'manual-generator.yml';
      await axios.post(`https://api.github.com/repos/${repo}/actions/workflows/${workflowFile}/dispatches`, {
        ref: 'main',
        inputs: { job_id: newJobId }
      }, {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28'
        }
      });
    } catch (ghErr) {
      console.error('  ⚠️ AutoPilot : Erreur déclenchement GitHub (le job sera traité au prochain cycle manuel):', ghErr.message);
    }
  } else {
    console.warn(`  ⚠️ AutoPilot : Lancement automatique sauté (Variables manquantes : ${!githubToken ? 'GH_PAT ' : ''}${!repo ? 'GITHUB_REPO' : ''})`);
  }

  // 8. Marquer le mot-clé comme traité
  await supabase
    .from('seo_backlog')
    .update({ status: 'done' })
    .eq('id', backlogItem.id);

  // 9. Mettre à jour le métronome du site
  await supabase
    .from('wordpress_sites')
    .update({ last_auto_seo_at: new Date().toISOString() })
    .eq('id', site.id);

  console.log(`  ✅ AutoPilot : Job ajouté et lancé.`);
  return true;
}

async function detect() {
  console.log('🔍 Démarrage de la détection (Mode Batch)...');

  // Reset stats IA pour ce run
  resetStats();
  const addedArticles = []; // { site: string, title: string }

  const { data: sites, error: siteError } = await supabase
    .from('wordpress_sites')
    .select('*')
    .eq('active', true);

  if (siteError) return console.error(siteError);

  for (const site of sites) {
    console.log(`\n--- Site : ${site.name} ---`);

    // --- Check AutoPilot SEO ---
    await checkAutoSeo(site);

    // 1. Check Intervalle RSS (Métronome Hebdomadaire)
    const siteMaxWeekly = site.max_articles_per_week || 7;
    const intervalHours = (7 * 24) / siteMaxWeekly;

    console.log(`ℹ️  Quota RSS : ${siteMaxWeekly} art/semaine (Intervalle cible: ${intervalHours.toFixed(1)}h)`);

    if (site.last_rss_detection_at) {
      const lastDetection = new Date(site.last_rss_detection_at);
      const diffHours = (new Date() - lastDetection) / (60 * 60 * 1000);

      if (diffHours < intervalHours) {
        console.log(`⏳ Trop tôt pour le RSS (Dernier ajout il y a ${diffHours.toFixed(1)}h). Skip.`);
        continue;
      }
    }

    // 1.bis Check Crédits
    const canAfford = await hasEnoughCredits(site.user_id, 1);
    if (!canAfford) {
      console.log('❌ Solde de crédits insuffisant. Skip.');
      continue;
    }
    console.log('✅ Crédits OK.');

    // 2. Récupération candidats (RSS)
    const { data: sources } = await supabase
      .from('source_sites')
      .select('*')
      .eq('wordpress_site_id', site.id)
      .eq('active', true);

    if (!sources || sources.length === 0) continue;

    let preCandidates = [];
    for (const source of sources) {
      if (source.type === 'rss' && source.rss_feed_url) {
        process.stdout.write(`  📡 RSS: ${source.rss_feed_url} `);
        const items = await fetchRSS(source.rss_feed_url);
        const recent = items.filter(i => (new Date() - i.pubDate) < 2 * DAY_IN_MS);
        recent.forEach(i => {
          i.source_id = source.id;
          i.source_type = 'rss';
        });
        preCandidates = [...preCandidates, ...recent];
        console.log(`(${recent.length} récents)`);
      }
    }

    // 3. Filtrage Technique
    const uniqueCandidates = [];
    for (const c of preCandidates) {
      const { data: exist } = await supabase.from('processed_articles').select('id').eq('wordpress_site_id', site.id).eq('source_url', c.link).single();
      const { data: queued } = await supabase.from('articles_queue').select('id').eq('wordpress_site_id', site.id).eq('source_url', c.link).single();
      if (!exist && !queued) uniqueCandidates.push(c);
    }

    if (uniqueCandidates.length === 0) {
      console.log('  Ø Aucun nouveau candidat technique.');
      continue;
    }

    console.log(`  🧐 Analyse IA de ${uniqueCandidates.length} candidats RSS...`);
    const candidatesToAnalyze = uniqueCandidates.sort((a, b) => b.pubDate - a.pubDate).slice(0, 20);
    const selectedIndices = await filterBestArticlesBatch(candidatesToAnalyze, site.persona);
    console.log(`  ✅ L'IA a retenu ${selectedIndices.length} articles RSS pertinents.`);

    // 5. Finalisation Queue
    let addedCount = 0;
    for (const idx of selectedIndices) {
      if (addedCount >= 1) break;
      const article = candidatesToAnalyze[idx];
      if (!article) continue;

      const textToEmbed = `${article.title} ${article.contentSnippet.substring(0, 500)}`;
      const embedding = await getEmbedding(textToEmbed);

      if (embedding) {
        const { data: matches } = await supabase.rpc('match_processed_articles', {
          query_embedding: embedding,
          match_threshold: RSS_SEMANTIC_MATCH_THRESHOLD,
          p_site_id: site.id
        });

        if (matches && matches.length > 0) {
          console.log(`    Ø Doublon sémantique RSS détecté : "${matches[0].source_title}"`);
          continue;
        }

        const { error } = await supabase.from('articles_queue').insert({
          wordpress_site_id: site.id,
          source_site_id: article.source_id,
          source_url: article.link,
          source_title: article.title,
          source_content_extract: article.contentSnippet.substring(0, 1000),
          embedding: embedding,
          status: 'pending',
          created_at: new Date()
        });

        if (!error) {
          console.log(`    -> 📥 Ajouté : ${article.title}`);
          addedArticles.push({ site: site.name, title: article.title });
          await supabase.from('wordpress_sites').update({ last_rss_detection_at: new Date().toISOString() }).eq('id', site.id);
          addedCount++;
        }
      }
    }
  }

  console.log('\n🏁 Fin détection.');

  // ── Notification Telegram ─────────────────────────────────────────────────
  await sendDetectionReport(addedArticles);
}

async function sendDetectionReport(addedArticles) {
  const stats = getStats();

  // Ne rien envoyer si aucun appel IA et aucun article (run vide/silencieux)
  if (stats.calls === 0 && addedArticles.length === 0) return;

  const lines = [];
  lines.push('🔍 <b>Détection RSS — bilan</b>');
  lines.push('');

  // Articles placés en pending
  if (addedArticles.length > 0) {
    lines.push(`📥 <b>${addedArticles.length} article(s) ajouté(s) en pending</b>`);
    for (const a of addedArticles) {
      lines.push(`  • [${a.site}] ${a.title}`);
    }
  } else {
    lines.push('📭 Aucun article ajouté en pending.');
  }

  // Stats IA
  lines.push('');
  lines.push('🤖 <b>Appels IA</b>');

  if (stats.calls === 0) {
    lines.push('  • Aucun appel effectué.');
  } else {
    const providers = [];
    if (stats.gemma > 0)    providers.push(`Gemma: ${stats.gemma}`);
    if (stats.cerebras > 0) providers.push(`Cerebras: ${stats.cerebras}`);
    if (stats.mistral > 0)  providers.push(`Mistral: ${stats.mistral}`);
    lines.push(`  • ${stats.calls} appel(s) — ${providers.join(', ') || 'aucun succès'}`);

    if (stats.errors > 0) {
      lines.push(`  ❌ ${stats.errors} appel(s) échoué(s) sur tous les providers`);
    }
  }

  // Fallbacks déclenchés
  if (stats.fallbacks.length > 0) {
    lines.push('');
    lines.push(`⚠️ <b>${stats.fallbacks.length} fallback(s) déclenchés</b>`);
    for (const f of stats.fallbacks) {
      const label = f.label.length > 50 ? f.label.substring(0, 50) + '…' : f.label;
      lines.push(`  • [${f.from}] ${label}`);
      lines.push(`    <i>${f.reason}</i>`);
    }
  }

  await sendTelegram(lines.join('\n'));
}

detect().catch(console.error);
