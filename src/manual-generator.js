// manual-generator.js - Version 2.2 (Expert vs Express - Anti-Bug)
require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { searchBrave } = require('./lib/research'); 
const { researchWithPerplexity } = require('./lib/perplexity');
const { researchWithTavily } = require('./lib/tavily');
const { generateContent: generateDeepSeek } = require('./lib/deepseek');
const { classifyArticle } = require('./lib/gemini');
const { generateRunwareImage } = require('./lib/runware');
const { uploadImageToWordPress, publishPost, getCategories } = require('./lib/wordpress');
const { decrypt } = require('./lib/encryption');
const { spendCredit, refundCredit } = require('./lib/credits');
const { upsertToWpCache } = require('./lib/supabase-data');
const { SEO_GENERATOR_PROMPT } = require('./prompts/seo-generator');
const { repairJson } = require('./lib/json-helper');
const { enqueueSocialPost } = require('./lib/social/enqueue');
const { sendTelegram } = require('./lib/telegram');

const { EXPERT_ANALYST_PROMPT } = require('./prompts/expert-analyst');
const { EXPERT_WRITER_PROMPT } = require('./prompts/expert-writer');

async function runManualJob() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('❌ Aucun ID de job fourni.');
    process.exit(1);
  }

  console.log(`🚀 Démarrage du Job Manuel: ${jobId}`);

  const { data: job, error: jobError } = await supabase
    .from('articles_queue')
    .select('*, wordpress_sites(*)')
    .eq('id', jobId)
    .single();

  if (jobError || !job) {
    console.error('❌ Job introuvable');
    process.exit(1);
  }

  const site = job.wordpress_sites;
  const mode = job.generation_mode || 'express';
  let creditsSpent = 0;
  console.log(`🎯 Mode détecté : ${mode.toUpperCase()}`);

  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    const { decrypt } = require('./lib/encryption');
    const [encrypted, authTag] = site.wp_password.split(':');
    wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
  }

  await supabase.from('articles_queue').update({ status: 'processing', processing_started_at: new Date() }).eq('id', jobId);

  const currentDate = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  const outputLanguage = job.custom_options?.output_language || 'fr';
  const languageNames = { fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand', it: 'italien', pt: 'portugais' };
  const languageName = languageNames[outputLanguage] || outputLanguage;
  const languageBlock = `# LANGUE — RÈGLE ABSOLUE\nTu dois rédiger EXCLUSIVEMENT en ${languageName}.\nAucun mot, caractère ou expression dans une autre langue n'est autorisé, quelle que soit la langue du modèle sous-jacent ou des données sources.\nSi les données sources contiennent du contenu dans une autre langue, traduis-le en ${languageName}.\nToute sortie contenant des caractères non-latins (chinois, japonais, arabe, cyrillique, etc.) est une erreur critique.`;

  try {
    let finalHtml = "";
    let aiMetadata = {};
    let infographicUrl = null;

    if (mode === 'expert') {
      await spendCredit(site.user_id, 5, jobId);
      creditsSpent = 5;
      console.log('  💳 5 crédits débités (EXPERT).');

      console.log('🔍 [EXPERT] Phase 1: Recherche Multi-Sources...');
      const bravePromise = searchBrave(job.source_title);
      let expertResearch = await researchWithTavily(job.source_title);
      if (!expertResearch) expertResearch = await researchWithPerplexity(job.source_title);
      const braveData = await bravePromise;
      if (!expertResearch) expertResearch = braveData; 

      console.log('🧠 [EXPERT] Phase 2: Analyse Stratégique...');
      const strategicBrief = await generateDeepSeek(EXPERT_ANALYST_PROMPT
        .replace('{{target_keyword}}', job.source_title)
        .replace('{{brave_results}}', braveData)
        .replace('{{perplexity_results}}', expertResearch)
        .replace('{{language_block}}', languageBlock)
        .replace(/\{\{current_date\}\}/g, currentDate), 'deepseek-reasoner');

      const expertPersona = site.persona || {};
      const writerPrompt = EXPERT_WRITER_PROMPT
        .replace('{{language_block}}', languageBlock)
        .replace('{{strategic_brief}}', strategicBrief)
        .replace('{{persona_nom}}', expertPersona.name || 'Expert')
        .replace('{{persona_background}}', expertPersona.background || '')
        .replace('{{persona_specialite}}', expertPersona.specialty || '')
        .replace('{{persona_ton}}', expertPersona.tone || 'Professionnel')
        .replace('{{persona_tics_langage}}', expertPersona.tics || '')
        .replace('{{persona_utilise_je}}', expertPersona.use_first_person ? 'Oui (Utilise "Je")' : 'Non (Reste impersonnel)')
        .replace('{{humanization_level}}', expertPersona.humanization_level || 'medium')
        .replace(/\{\{current_date\}\}/g, currentDate)
        .replace('{{target_length}}', job.target_length === 'long' ? '2200' : '1500');

      let aiOutput = null;
      for (let i = 1; i <= 2; i++) {
        console.log(`✍️ [EXPERT] Phase 3: Rédaction Premium - Tentative ${i}/2...`);
        try {
          const raw = await generateDeepSeek(writerPrompt, 'deepseek-reasoner');
          const parsed = parseAiJson(raw);
          if (parsed._isTruncated && i === 1) {
            console.warn("  ⚠️ Tronqué, relance...");
            continue;
          }
          aiOutput = parsed;
          break;
        } catch (e) {
          console.error(`  ❌ Échec tentative ${i}: ${e.message}`);
          if (i === 2) throw e;
        }
      }

      aiMetadata = aiOutput.metadata;
      finalHtml = (aiOutput.html || "").replace(/\{[\s\S]*?"@context":\s*"https:\/\/schema\.org"[\s\S]*?\}/gi, '').trim();

      if (aiOutput.faq) {
        console.log('  ❓ Ajout du FAQ Schema (JSON-LD)...');
        const faqItems = aiOutput.faq.map(f => ({
          "@type": "Question", "name": f.question, "acceptedAnswer": { "@type": "Answer", "text": f.answer }
        }));
        finalHtml += `\n<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify({
          "@context": "https://schema.org", "@type": "FAQPage", "mainEntity": faqItems
        }, null, 2)}\n</script>\n<!-- /wp:html -->\n`;
      }

      if (aiMetadata.infographic_prompt) {
        const infographicModel = job.infographic_model || site.auto_seo_infographic_style || 'banana';
        const runwareModel = infographicModel === 'flux' ? 'runware:400@1' : 'google:4@3';
        console.log(`📊 [EXPERT] Phase 4: Infographie (${infographicModel})...`);
        try {
          infographicUrl = await generateRunwareImage(aiMetadata.infographic_prompt, "infographic", 3, runwareModel);
        } catch (e) {}
      }

    } else {
      // MODE EXPRESS
      await spendCredit(site.user_id, 3, jobId);
      creditsSpent = 3;
      const persona = site.persona || {};
      const searchResults = await searchBrave(job.source_title);

      const expressLength = job.target_length === 'long' ? '1800' : job.target_length === 'short' ? '800' : '1200';
      const expressPrompt = SEO_GENERATOR_PROMPT
        .replace('{{target_keyword}}', job.source_title)
        .replace('{{search_results}}', searchResults)
        .replace('{{language_block}}', languageBlock)
        .replace(/\{\{current_date\}\}/g, currentDate)
        .replace('{{target_length}}', expressLength)
        .replace('{{persona_nom}}', persona.name || 'Expert')
        .replace('{{persona_background}}', persona.background || '')
        .replace('{{persona_specialite}}', persona.specialty || '')
        .replace('{{persona_ton}}', persona.tone || 'Professionnel')
        .replace('{{persona_tics_langage}}', persona.tics || '')
        .replace('{{persona_utilise_je}}', persona.use_first_person ? 'Oui (Utilise "Je")' : 'Non (Reste impersonnel)')
        .replace('{{persona_particularites}}', persona.particularities || '')
        .replace('{{humanization_level}}', persona.humanization_level || 'medium');

      console.log('  🧠 [EXPRESS] Génération DeepSeek V3...');
      let aiOutput = null;
      for (let i = 1; i <= 2; i++) {
        const model = i === 1 ? 'deepseek-chat' : 'deepseek-reasoner';
        if (i === 2) console.warn('  ⚠️ [EXPRESS] Troncature détectée — relance sur deepseek-reasoner...');
        const raw = await generateDeepSeek(expressPrompt, model);
        const parsed = parseAiJson(raw);
        if (parsed._isTruncated && i === 1) continue;
        aiOutput = parsed;
        break;
      }
      console.log('  ✅ [EXPRESS] Génération terminée.');

      aiMetadata = aiOutput.wordpress || aiOutput.metadata;
      finalHtml = aiMetadata.content || aiMetadata.html || aiOutput.content || aiOutput.html;
    }

    if (!finalHtml || finalHtml.trim().length < 100) {
      throw new Error('Contenu généré vide ou trop court — publication annulée.');
    }

    const categories = await getCategories(site);
    const categoryId = await classifyArticle(aiMetadata.title, aiMetadata.excerpt, categories);

    console.log('🖼️ Images...');
    const featuredImageUrl = await generateRunwareImage(aiMetadata.image_generation_prompt, "photo");
    const featuredMedia = await uploadImageToWordPress(site.url, site.wp_user, wpPassword, featuredImageUrl, aiMetadata.title, site.connection_mode, site.bridge_key);

    const isBridgeMode = site.connection_mode === 'bridge_plugin';
    const infographicAlt = `Infographie : ${job.source_title}`;

    if (infographicUrl) {
      let infoImgSrc = null;

      if (isBridgeMode) {
        // En mode Bridge, l'upload REST est risqué (WAF). On passe l'URL externe au plugin
        // qui se charge du sideload + alt text côté serveur WordPress.
        infoImgSrc = infographicUrl;
      } else {
        const infoMedia = await uploadImageToWordPress(site.url, site.wp_user, wpPassword, infographicUrl, infographicAlt, 'rest_api', site.bridge_key);
        if (infoMedia?.url) infoImgSrc = infoMedia.url;
      }

      if (infoImgSrc) {
        const imgHtml = `\n<!-- wp:image {"sizeSlug":"large"} --><figure class="wp-block-image size-large"><img src="${infoImgSrc}" alt="${infographicAlt}"/></figure><!-- /wp:image -->\n`;
        const parts = finalHtml.split(/<h2/i);
        finalHtml = parts.length > 2 ? parts[0] + '<h2' + parts[1] + imgHtml + parts.slice(2).map(p => '<h2' + p).join('') : finalHtml + imgHtml;
      }
    }

    console.log('📤 Publication...');
    const pubResult = await publishPost({ ...site, wp_password: wpPassword }, {
      title: aiMetadata.title, content: finalHtml, excerpt: aiMetadata.excerpt, slug: aiMetadata.slug,
      status: job.custom_status || site.default_status || 'draft', categories: [categoryId],
      featured_media_id: featuredMedia?.id, featured_media_url: featuredMedia?.url || featuredImageUrl,
      date: job.scheduled_at || null,
      infographic_url: infographicUrl || null,
      infographic_alt: infographicUrl ? infographicAlt : null
    });

    await supabase.from('articles_queue').update({ status: 'published', processed_at: new Date(), published_title: aiMetadata.title, published_url: pubResult.link }).eq('id', jobId);

    await enqueueSocialPost(site.id, jobId, 'seo', job.scheduled_at);

    // Mise à jour du cache wp_posts_cache (aspy-data) pour les badges doublons UI
    if (pubResult.id) {
      await upsertToWpCache({
        userId: site.user_id,
        wordpressSiteId: site.id,
        wpPostId: pubResult.id,
        title: aiMetadata.title,
        slug: aiMetadata.slug,
        link: pubResult.link,
        status: job.custom_status || site.default_status || 'draft',
        postDate: job.scheduled_at || new Date().toISOString(),
      });
    }

    console.log(`✅ Succès : ${pubResult.link}`);
    await sendTelegram(`✅ <b>[SEO ${mode.toUpperCase()}]</b> Article publié\n• <a href="${pubResult.link}">${aiMetadata.title}</a>\n• ${site.name}`);
    process.exit(0);

  } catch (error) {
    console.error(`❌ Erreur : ${error.message}`);
    if (creditsSpent > 0) await refundCredit(site.user_id, creditsSpent, jobId);
    await supabase.from('articles_queue').update({ status: 'failed', error_message: error.message }).eq('id', jobId);
    await sendTelegram(`❌ <b>[SEO ${mode.toUpperCase()}]</b> Échec\n• ${job?.source_title || jobId}\n• ${site?.name || '?'}\n└ ${error.message}`);
    process.exit(1);
  }
}

function parseAiJson(text) {
  let jsonStr = text.trim().replace(/```json/g, '').replace(/```/g, '');
  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace === -1) throw new Error("Structure JSON non trouvée");
  const lastBrace = jsonStr.lastIndexOf('}');
  if (lastBrace !== -1 && lastBrace > firstBrace) {
    try {
      const parsed = JSON.parse(jsonStr.substring(firstBrace, lastBrace + 1));
      parsed._isTruncated = false;
      return parsed;
    } catch (e) {}
  }
  const { json: fixed, isTruncated } = repairJson(jsonStr);
  const parsed = JSON.parse(fixed);
  parsed._isTruncated = isTruncated;
  return parsed;
}

runManualJob();
