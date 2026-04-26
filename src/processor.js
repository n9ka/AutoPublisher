require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { scrapeArticle } = require('./lib/scraper');
const { generateContent } = require('./lib/deepseek');
const { classifyArticle } = require('./lib/gemini');
const { searchImage } = require('./lib/pexels');
const { generateRunwareImage } = require('./lib/runware');
const { uploadImageToWordPress, publishPost, getCategories } = require('./lib/wordpress');
const { decrypt } = require('./lib/encryption');
const { spendCredit, refundCredit } = require('./lib/credits');
const { upsertToWpCache } = require('./lib/supabase-data');
const { MAIN_PROMPT } = require('./prompts/templates');
const { TREND_SPY_PROMPT } = require('./prompts/trend-spy');
const { buildLanguageBlock } = require('./lib/languages');
const { repairJson, repairJsonWithAI } = require('./lib/json-helper');
const { enqueueSocialPost } = require('./lib/social/enqueue');
const { sendTelegram } = require('./lib/telegram');

async function processNextArticle() {
  console.log('⚙️  Recherche d\'un article en attente...');

  const { data: queueItem, error: queueError } = await supabase
    .from('articles_queue')
    .select('*, wordpress_sites(*)')
    .eq('status', 'pending')
    .in('source_type', ['rss', 'trend']) // On ignore les jobs 'manual'
    .limit(1)
    .single();

  if (queueError || !queueItem) {
    console.log('💤 Aucun article en attente.');
    return null;
  }

  const articleId = queueItem.id;
  const site = queueItem.wordpress_sites;
  const userId = site.user_id;
  const isTrend = queueItem.source_type === 'trend';
  let creditsSpent = 0; // Track pour le refund
  
  console.log(`🚀 Traitement [${(queueItem.source_type || 'rss').toUpperCase()}]: "${queueItem.source_title}" pour ${site.name}`);

  // Déchiffrement du mot de passe WordPress
  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    if (!process.env.ENCRYPTION_KEY) {
      throw new Error('ENCRYPTION_KEY manquante dans l\'environnement.');
    }
    try {
      const [encrypted, authTag] = site.wp_password.split(':');
      wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
      console.log('  🔐 Mot de passe WP déchiffré.');
    } catch (e) {
      throw new Error('Erreur déchiffrement mot de passe WP.');
    }
  }

  await supabase
    .from('articles_queue')
    .update({ status: 'processing', processing_started_at: new Date() })
    .eq('id', articleId);

  try {
    // 1. Récupération du contenu
    let finalContent = "";
    let isFallback = false;

    if (isTrend) {
      // Pour les tendances, on utilise le contexte de recherche (LangSearch)
      finalContent = queueItem.source_content_extract;
      if (!finalContent || finalContent.length < 150) {
        console.warn('  ⚠️ Données LangSearch faibles. Utilisation du titre comme base.');
        finalContent = `Sujet : ${queueItem.source_title}. Effectue une analyse approfondie sur ce sujet actuel.`;
      }
    } else {
      // Scraping classique pour RSS
      console.log('  📄 Scraping contenu source...');
      let sourceData = await scrapeArticle(queueItem.source_url);
      finalContent = sourceData?.content;

      if (!finalContent || finalContent.length < 500) {
        console.warn(`  ⚠️ Scraping insuffisant. Tentative de fallback RSS...`);
        if (queueItem.source_content_extract && queueItem.source_content_extract.length > 100) {
          finalContent = queueItem.source_content_extract;
          isFallback = true;
          console.log('  ✅ Fallback réussi via extrait RSS.');
        } else {
          throw new Error('Contenu source inaccessible.');
        }
      }
    }

    // 2. Crédit (1 pour RSS, 2 pour Trend)
    const creditCost = isTrend ? 2 : 1;
    await spendCredit(userId, creditCost, articleId);
    creditsSpent = creditCost;
    console.log(`  💳 ${creditCost} crédit(s) débité(s).`);

    // 3. Génération IA (DeepSeek)
    const promptTemplate = isTrend ? TREND_SPY_PROMPT : MAIN_PROMPT;
    console.log(`  🧠 Génération IA [${isTrend ? 'TREND SPY' : (isFallback ? 'FALLBACK' : 'CLASSIC')}]...`);

    const persona = site.persona || {};
    const currentDate = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
    const langCode = site.default_language || 'fr';
    const languageBlock = buildLanguageBlock(langCode);

    let filledPrompt = promptTemplate
      .replace('{{language_block}}', languageBlock)
      .replace('{{persona_nom}}', persona.name || 'Expert')
      .replace('{{persona_background}}', persona.background || '')
      .replace('{{persona_ton}}', persona.tone || 'Professionnel')
      .replace('{{persona_specialite}}', persona.specialty || '')
      .replace('{{persona_tics_langage}}', persona.tics || '')
      .replace('{{persona_utilise_je}}', persona.use_first_person ? 'Oui (Utilise "Je")' : 'Non (Reste impersonnel)')
      .replace('{{persona_particularites}}', persona.particularities || '')
      .replace('{{humanization_level}}', persona.humanization_level || 'medium')
      .replace('{{current_date}}', currentDate)
      .replace('{{source_content}}', finalContent.substring(0, 15000))
      .replace('{{search_results}}', finalContent.substring(0, 15000))
      .replace('{{trend_title}}', queueItem.source_title);

    const rawResponse = await generateContent(filledPrompt);
    
    let aiOutput;
    try {
      aiOutput = await parseAiJson(rawResponse);
    } catch (e) {
      console.error("Détail erreur JSON:", e.message);
      throw new Error('Sortie IA invalide (pas de JSON parsable)');
    }

    const wpData = aiOutput.wordpress;

    // 4. Classification
    console.log('  🏷️  Classification...');
    const secureSiteForCats = { ...site, wp_password: wpPassword };
    const categories = await getCategories(secureSiteForCats);
    const categoryId = await classifyArticle(wpData.title, wpData.excerpt, categories);

    // 5. Image
    let featuredMediaId = null;
    let featuredMediaUrl = null;
    let imageUrl = null;
    let imageSource = site.image_provider || 'pexels';

    if (imageSource === 'runware' && process.env.RUNWARE_API_KEY) {
      imageUrl = await generateRunwareImage(wpData.image_generation_prompt);
    }

    if (!imageUrl && process.env.PEXELS_API_KEY) {
      const pexelsRes = await searchImage(wpData.image_search_query || wpData.keywords.split(',')[0], langCode);
      imageUrl = pexelsRes ? pexelsRes.url : null;
    }

    if (imageUrl) {
      const media = await uploadImageToWordPress(
        site.url, 
        site.wp_user, 
        wpPassword, 
        imageUrl, 
        wpData.title,
        site.connection_mode,
        site.bridge_key
      );
      featuredMediaId = media ? media.id : null;
      featuredMediaUrl = media ? media.url : null;
    }

    // 6. Publication
    console.log('  📤 Publication WordPress...');
    const postPayload = {
      title: wpData.title,
      content: wpData.content || wpData["HTML-IA"], // Support des deux formats de prompt
      excerpt: wpData.excerpt,
      slug: wpData.slug,
      keywords: wpData.keywords, // Ajout des mots-clés pour le maillage
      status: site.default_status || 'draft',
      categories: [categoryId],
      featured_media_id: featuredMediaId,
      featured_media_url: featuredMediaUrl
    };

    if (process.env.DRY_RUN === 'true') {
      console.log('  [DRY RUN] Payload OK');
      await supabase
        .from('articles_queue')
        .update({
          status: 'published',
          processed_at: new Date(),
          published_title: wpData.title,
          published_url: 'https://dry-run.test'
        })
        .eq('id', articleId);
      return { status: 'published', title: wpData.title, url: 'https://dry-run.test', siteName: site.name, credits: creditsSpent, jsonRepaired: !!aiOutput._jsonRepaired };
    } else {
      const secureSiteConfig = { ...site, wp_password: wpPassword };
      const pubResult = await publishPost(secureSiteConfig, postPayload);
      console.log(`  ✅ PUBLIÉ ! URL: ${pubResult.link}`);

      await supabase.from('processed_articles').insert({
        wordpress_site_id: site.id,
        source_url: queueItem.source_url,
        source_title: queueItem.source_title,
        embedding: queueItem.embedding,
        wordpress_post_id: pubResult.id,
        wordpress_url: pubResult.link,
        category_id: categoryId
      });

      await supabase
        .from('articles_queue')
        .update({
          status: 'published',
          processed_at: new Date(),
          published_title: wpData.title,
          published_url: pubResult.link
        })
        .eq('id', articleId);

      await enqueueSocialPost(site.id, articleId, queueItem.source_type, queueItem.scheduled_at);

      if (pubResult.id) {
        await upsertToWpCache({
          userId,
          wordpressSiteId: site.id,
          wpPostId: pubResult.id,
          title: wpData.title,
          slug: wpData.slug,
          link: pubResult.link,
          status: site.default_status || 'publish',
          postDate: new Date().toISOString(),
        });
      }

      return { status: 'published', title: wpData.title, url: pubResult.link, siteName: site.name, credits: creditsSpent, jsonRepaired: !!aiOutput._jsonRepaired };
    }

  } catch (error) {
    console.error(`  ❌ ERREUR: ${error.message}`);

    // NOUVEAU : Remboursement automatique en cas d'échec
    if (creditsSpent > 0) {
      try {
        await refundCredit(userId, creditsSpent, articleId);
        console.log(`  💰 ${creditsSpent} crédit(s) remboursé(s) à l'utilisateur.`);
      } catch (refundErr) {
        console.error(`  ⚠️ Échec du remboursement : ${refundErr.message}`);
      }
    }

    await supabase
      .from('articles_queue')
      .update({
        status: 'failed',
        error_message: error.message,
        processed_at: new Date()
      })
      .eq('id', articleId);
    return { status: 'failed', title: queueItem.source_title, siteName: site?.name || '?', error: error.message };
  }
}

async function parseAiJson(text) {
  let jsonStr = text.trim();
  // Nettoyage Markdown
  jsonStr = jsonStr.replace(/```json/g, '').replace(/```/g, '');

  const firstBrace = jsonStr.indexOf('{');
  const lastBrace = jsonStr.lastIndexOf('}');

  if (firstBrace === -1 || lastBrace === -1) {
    throw new Error("Structure JSON non trouvée dans la réponse IA");
  }

  const rawJson = jsonStr.substring(firstBrace, lastBrace + 1);

  try {
    // 1. Tentative Standard
    return JSON.parse(rawJson);
  } catch (e) {
    console.warn("⚠️ JSON standard échoué, tentative de réparation des caractères d'échappement...");
    try {
      // 2. Tentative de secours via le helper
      const { json: fixedJson } = repairJson(rawJson);
      return JSON.parse(fixedJson);
    } catch (e2) {
      // 3. Dernier recours : réparation par IA (OpenRouter Gemini Flash Lite)
      console.warn("⚠️ Réparation locale échouée, tentative OpenRouter (Gemini Flash Lite)...");
      try {
        const fixed = await repairJsonWithAI(rawJson);
        const parsed = JSON.parse(fixed);
        parsed._isTruncated = false;
        parsed._jsonRepaired = true;
        console.log("  ✅ Réparation IA réussie.");
        return parsed;
      } catch (e3) {
        console.error("Échec sauvetage JSON. Fin du texte :", jsonStr.slice(-300));
        throw new Error(`Erreur JSON fatale: ${e3.message}`);
      }
    }
  }
}

// Boucle principale
(async () => {
  console.log('📦 Démarrage du processeur...');
  const MAX_ARTICLES_PER_RUN = 20; // Sécurité pour éviter d'exploser les minutes GitHub
  let hasMore = true;
  const published = [];
  const failed = [];

  while (hasMore && (published.length + failed.length) < MAX_ARTICLES_PER_RUN) {
    const result = await processNextArticle();
    if (result === null) {
      hasMore = false;
    } else {
      if (result.status === 'published') published.push(result);
      else if (result.status === 'failed') failed.push(result);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }

  const total = published.length + failed.length;

  if (total >= MAX_ARTICLES_PER_RUN) {
    console.log(`⚠️  Limite de ${MAX_ARTICLES_PER_RUN} articles atteinte pour ce run.`);
  }

  console.log(`🏁 Fin du run. ${total} article(s) traité(s).`);

  // Résumé Telegram
  if (total > 0) {
    const date = new Date().toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' });
    const lines = [`📰 <b>Run AutoPublisher — ${date}</b>`];

    if (published.length > 0) {
      const totalCredits = published.reduce((sum, r) => sum + (r.credits || 0), 0);
      lines.push(`\n✅ <b>${published.length} publié(s)</b>`);
      for (const r of published) {
        const repairTag = r.jsonRepaired ? ' 🔧' : '';
        lines.push(`• <a href="${r.url}">${r.title}</a> — ${r.siteName}${repairTag}`);
      }
      lines.push(`\n💳 Crédits consommés : ${totalCredits}`);
      const repairedCount = published.filter(r => r.jsonRepaired).length;
      if (repairedCount > 0) lines.push(`⚠️ ${repairedCount} JSON réparé(s) par IA (OpenRouter)`);
    }

    if (failed.length > 0) {
      lines.push(`\n❌ <b>${failed.length} échec(s)</b>`);
      for (const r of failed) {
        lines.push(`• ${r.title} — ${r.siteName}\n  └ ${r.error}`);
      }
    }

    await sendTelegram(lines.join('\n'));
  }

  process.exit(0);
})().catch(async (error) => {
  console.error('💥 Erreur fatale:', error);
  await sendTelegram(`💥 <b>Erreur fatale AutoPublisher</b>\n${error.message}`);
  process.exit(1);
});