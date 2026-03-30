require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { generateContent } = require('./lib/deepseek');
const { postToSocial } = require('./lib/social/index');
const { spendCredit } = require('./lib/credits');
const { repairJson } = require('./lib/json-helper');

const MAX_RETRIES = 3;

/**
 * Génère le texte du post via DeepSeek
 */
async function generatePostText(article, site) {
  const persona = site.persona ?? {};
  const personaDesc = [
    persona.tone   ? `Ton : ${persona.tone}.`      : '',
    persona.topic  ? `Thématique : ${persona.topic}.` : '',
  ].filter(Boolean).join(' ') || 'Ton professionnel et engageant.';

  const title   = article.published_title || article.source_title || article.content?.title || 'Sans titre';
  const url     = article.published_url || article.content?.wp_url || '';
  const excerpt = article.content?.excerpt || article.content?.intro || '';

  const prompt = `Tu es le community manager du site "${site.name}".
${personaDesc}

Article publié :
- Titre : ${title}
- URL : ${url}
- Résumé : ${excerpt}

Rédige un post percutant pour annoncer cet article sur les réseaux sociaux.
Règles strictes :
- Maximum 240 caractères (l'URL sera ajoutée automatiquement après)
- 2-3 emojis pertinents au début
- Accroche émotionnelle ou question qui donne envie de cliquer
- 2-3 hashtags ciblés à la fin
- Style réseau social natif, pas "article de blog"
- Pas de guillemets, pas de "Découvrez"

Réponds UNIQUEMENT avec ce JSON :
{"text": "..."}`;

  const raw = await generateContent(prompt, 'deepseek-chat');

  let text = '';
  try {
    const { json } = repairJson(raw);
    text = JSON.parse(json).text || '';
  } catch {
    // Fallback regex si repairJson produit du JSON invalide (emojis, caractères spéciaux)
    const match = raw.match(/"text"\s*:\s*"([\s\S]*?)"\s*[,}]/);
    text = match?.[1]?.replace(/\\n/g, '\n') || '';
  }

  if (!text) throw new Error('Génération du texte échouée — réponse DeepSeek vide ou invalide');

  // Sécurité : tronque si dépassement
  if (text.length > 240) {
    text = text.slice(0, 237) + '...';
  }

  // Ajoute l'URL si présente
  return url ? `${text}\n${url}` : text;
}

/**
 * Traite les jobs en attente dans social_queue
 */
async function processQueue() {
  console.log('📱 Recherche de posts sociaux en attente...');

  const { data: jobs, error } = await supabase
    .from('social_queue')
    .select(`
      *,
      wordpress_sites (
        id, name, persona,
        site_social_config (
          id, channel_ids, posting_enabled,
          user_social_accounts (
            id, provider, api_key, api_key_iv, api_key_auth_tag,
            quota_limits, quota_usage
          )
        )
      )
    `)
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .lt('retry_count', MAX_RETRIES)
    .order('created_at', { ascending: true })
    .limit(20);

  if (error) {
    console.error('❌ Erreur lecture social_queue:', error.message);
    return;
  }

  if (!jobs?.length) {
    console.log('💤 Aucun post en attente.');
    return;
  }

  console.log(`📋 ${jobs.length} post(s) à traiter.`);

  for (const job of jobs) {
    const site        = job.wordpress_sites;
    const siteConfig  = site?.site_social_config?.[0];
    const account     = siteConfig?.user_social_accounts;

    if (!siteConfig || !account) {
      console.warn(`  ⚠️  Job ${job.id} : config sociale manquante pour le site.`);
      await supabase
        .from('social_queue')
        .update({ status: 'failed', error: 'Config sociale manquante' })
        .eq('id', job.id);
      continue;
    }

    if (!siteConfig.posting_enabled) {
      console.log(`  ⏭️  Job ${job.id} : posting désactivé pour ce site.`);
      await supabase
        .from('social_queue')
        .update({ status: 'failed', error: 'Posting désactivé' })
        .eq('id', job.id);
      continue;
    }

    console.log(`\n🚀 Job ${job.id} — site : ${site.name} — source : ${job.source_type}`);

    // Marquer en cours
    await supabase
      .from('social_queue')
      .update({ status: 'processing' })
      .eq('id', job.id);

    try {
      // Récupère l'article pour le contexte
      const { data: article } = await supabase
        .from('articles_queue')
        .select('source_title, published_url, published_title, content')
        .eq('id', job.article_id)
        .single();

      const text = await generatePostText(article ?? {}, site);
      console.log(`  ✍️  Texte généré (${text.length} chars)`);

      const results = await postToSocial(siteConfig, account, text);
      const postIds = results.map(r => r.postId).filter(Boolean).join(',');
      console.log(`  ✅ Posté — IDs: ${postIds}`);

      await supabase
        .from('social_queue')
        .update({
          status: 'posted',
          text,
          provider_post_id: postIds,
          posted_at: new Date().toISOString(),
        })
        .eq('id', job.id);

      // Crédit non bloquant
      try {
        const userId = (await supabase
          .from('wordpress_sites')
          .select('user_id')
          .eq('id', job.site_id)
          .single()
        ).data?.user_id;

        if (userId) {
          await spendCredit(userId, 1, job.article_id);
          console.log(`  💳 1 crédit débité`);
        }
      } catch (creditErr) {
        console.warn(`  ⚠️  Crédit non débité : ${creditErr.message}`);
      }

    } catch (err) {
      console.error(`  ❌ Échec : ${err.message}`);

      const newRetryCount = (job.retry_count ?? 0) + 1;
      const isFinal = newRetryCount >= MAX_RETRIES;

      await supabase
        .from('social_queue')
        .update({
          status: isFinal ? 'failed' : 'pending',
          retry_count: newRetryCount,
          error: err.message,
        })
        .eq('id', job.id);

      if (isFinal) {
        console.log(`  🚫 Job ${job.id} marqué failed après ${MAX_RETRIES} tentatives.`);
      }
    }
  }
}

async function run() {
  console.log('🚀 Social Poster démarré');
  await processQueue();
  console.log('\n✅ Social Poster terminé');
  process.exit(0);
}

run().catch(err => {
  console.error('💥 Erreur fatale:', err);
  process.exit(1);
});
