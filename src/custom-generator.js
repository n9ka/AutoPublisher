// custom-generator.js — Mode Personnalisé (Custom SEO)
// Pipeline 4 phases : Recherche → Brief → Rédaction → Médias → Publication
require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { searchBrave } = require('./lib/research');
const { researchWithTavily } = require('./lib/tavily');
const { generateWithLLM } = require('./lib/llm-client');
const { generateRunwareImage } = require('./lib/runware');
const { uploadImageToWordPress, publishPost, getCategories } = require('./lib/wordpress');
const { decrypt } = require('./lib/encryption');
const { spendCredit, refundCredit } = require('./lib/credits');
const { upsertToWpCache } = require('./lib/supabase-data');
const { classifyArticle } = require('./lib/gemini');
const { enqueueSocialPost } = require('./lib/social/enqueue');
const { CUSTOM_ANALYST_PROMPT } = require('./prompts/custom-analyst');
const { CUSTOM_WRITER_PROMPT } = require('./prompts/custom-writer');
const { repairJson } = require('./lib/json-helper');

// Coûts fixes par composant (crédits)
const FIXED_COSTS = {
  research: 1,      // Brave + Tavily
  infographic: 1.5, // Runware NanoBanana
  section_img: 0.5, // Runware par image de section
};

/**
 * Calcule le coût total d'un job custom
 * @param {Object} opts — custom_options JSONB
 * @param {Object} briefModel — ligne llm_models
 * @param {Object} writingModel — ligne llm_models
 * @returns {number}
 */
function calculateTotalCredits(opts, briefModel, writingModel) {
  const sectionImgCount = opts.section_images === -1 ? 6 : (opts.section_images || 0);
  let total = FIXED_COSTS.research;
  total += briefModel.credits_per_call;
  total += writingModel.credits_per_call;
  if (opts.infographic) total += FIXED_COSTS.infographic;
  if (sectionImgCount > 0) total += sectionImgCount * FIXED_COSTS.section_img;
  return total;
}

function parseAiJson(text) {
  let jsonStr = text.trim().replace(/```json/g, '').replace(/```/g, '');
  const firstBrace = jsonStr.indexOf('{');
  if (firstBrace === -1) throw new Error('Structure JSON non trouvée dans la réponse LLM');
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

/**
 * Injecte les images de section dans le HTML Gutenberg
 * Remplace les marqueurs <!-- SECTION_IMAGE_N --> par des blocs wp:image
 * @param {string[]} altTexts — descriptions des images (pour l'attribut alt)
 */
function injectSectionImages(html, sectionImageUrls, altTexts = []) {
  let result = html;
  sectionImageUrls.forEach((url, idx) => {
    if (!url) return;
    const marker = `<!-- SECTION_IMAGE_${idx + 1} -->`;
    const alt = (altTexts[idx] || '').replace(/"/g, '&quot;').substring(0, 120);
    const block = `\n<!-- wp:image {"sizeSlug":"large"} --><figure class="wp-block-image size-large"><img src="${url}" alt="${alt}"/></figure><!-- /wp:image -->\n`;
    result = result.replace(marker, block);
  });
  // Nettoyer les marqueurs sans image
  result = result.replace(/<!-- SECTION_IMAGE_\d+ -->/g, '');
  return result;
}

async function runCustomJob() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('❌ Aucun ID de job fourni.');
    process.exit(1);
  }

  console.log(`🚀 [CUSTOM] Démarrage du Job: ${jobId}`);

  // Chargement du job
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
  const opts = job.custom_options;

  if (!opts) {
    console.error('❌ custom_options manquant dans le job');
    process.exit(1);
  }

  // Chargement des modèles LLM depuis la DB
  const { data: briefModel } = await supabase.from('llm_models').select('*').eq('id', opts.brief_model_id).single();
  const { data: writingModel } = await supabase.from('llm_models').select('*').eq('id', opts.model_id).single();

  if (!briefModel || !writingModel) {
    console.error('❌ Modèle LLM introuvable en DB');
    process.exit(1);
  }

  console.log(`  🤖 Brief: ${briefModel.label} | Rédaction: ${writingModel.label}`);

  // Décryptage mot de passe WordPress
  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    const [encrypted, authTag] = site.wp_password.split(':');
    wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
  }

  await supabase.from('articles_queue').update({ status: 'processing', processing_started_at: new Date() }).eq('id', jobId);

  const totalCredits = calculateTotalCredits(opts, briefModel, writingModel);
  let creditsSpent = 0;
  const currentDate = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const keyword = job.source_title;

  try {
    // Débit des crédits EN DÉBUT (cohérent avec manual-generator.js)
    await spendCredit(site.user_id, totalCredits, jobId);
    creditsSpent = totalCredits;
    console.log(`  💳 ${totalCredits} crédits débités (CUSTOM).`);

    // ── PHASE 0 : Recherche parallèle ──────────────────────────────────────
    console.log('🔍 [CUSTOM] Phase 0: Recherche parallèle...');
    const [braveResults, tavilyResults] = await Promise.all([
      searchBrave(keyword, false),
      researchWithTavily(keyword),
    ]);

    // ── PHASE 1 : Brief stratégique ────────────────────────────────────────
    console.log(`🧠 [CUSTOM] Phase 1: Brief stratégique (${briefModel.label})...`);

    const targetLength = opts.target_length === 'long' ? '3000' : '2000';
    const sectionImgCount = opts.section_images === -1 ? 6 : (opts.section_images || 0);

    const infographicBriefBlock = opts.infographic
      ? `## Brief Infographie\nDécris dans "infographic_prompt" une scène conceptuelle forte illustrant le sujet principal. Style illustration 2D flat-vector, textes en FRANÇAIS limités à 1 titre + 3-5 mots-clés.`
      : '';

    const sectionImagesBlock = sectionImgCount > 0
      ? `## Prompts Images de Section\nGénère ${sectionImgCount} entrées dans "section_image_prompts" (prompts EN ANGLAIS pour Runware : photographie professionnelle textless, sujet unique) ET ${sectionImgCount} entrées dans "section_image_alts" (textes alternatifs EN FRANÇAIS, 60-80 caractères, intègrent le mot-clé de la section correspondante, descriptifs et naturels).`
      : '';

    const researchInstructionsBlock = opts.research_instructions
      ? `## Instructions Recherche Personnalisées\n${opts.research_instructions}`
      : '';

    const outputLanguage = opts.output_language || 'fr';
    const languageNames = { fr: 'français', en: 'anglais', es: 'espagnol', de: 'allemand', it: 'italien', pt: 'portugais' };
    const languageName = languageNames[outputLanguage] || outputLanguage;
    const languageBlock = `# LANGUE — RÈGLE ABSOLUE\nTu dois rédiger EXCLUSIVEMENT en ${languageName}.\nAucun mot, caractère ou expression dans une autre langue n'est autorisé, quelle que soit la langue du modèle sous-jacent ou des données sources.\nSi les données sources contiennent du contenu dans une autre langue, traduis-le en ${languageName}.\nToute sortie contenant des caractères non-latins (chinois, japonais, arabe, cyrillique, etc.) est une erreur critique.`;

    const analystPrompt = CUSTOM_ANALYST_PROMPT
      .replace('{{keyword}}', keyword)
      .replace('{{brave_results}}', braveResults || 'Aucun résultat Brave disponible')
      .replace('{{tavily_results}}', tavilyResults || 'Aucun résultat Tavily disponible')
      .replace('{{options_json}}', JSON.stringify(opts, null, 2))
      .replace('{{target_length}}', targetLength)
      .replace('{{current_date}}', currentDate)
      .replace('{{language_block}}', languageBlock)
      .replace('{{research_instructions_block}}', researchInstructionsBlock)
      .replace('{{infographic_brief_block}}', infographicBriefBlock)
      .replace('{{section_images_block}}', sectionImagesBlock);

    const briefRaw = await generateWithLLM(analystPrompt, briefModel);
    const strategicBrief = parseAiJson(briefRaw);
    console.log('  ✅ Brief généré. Format détecté:', strategicBrief.format);

    // ── PHASE 2 : Rédaction ────────────────────────────────────────────────
    console.log(`✍️ [CUSTOM] Phase 2: Rédaction (${writingModel.label})...`);

    const persona = site.persona || {};

    let stepNum = 1;
    const readingTimeBlock = opts.reading_time
      ? `### ${stepNum++}. TEMPS DE LECTURE — PREMIER ÉLÉMENT ABSOLU (RIEN AVANT, même pas une phrase d'intro)\n<!-- wp:paragraph --><p class="reading-time" style="font-style:italic;margin-bottom:20px;"><i class="fa-solid fa-clock"></i> Temps de lecture : X min</p><!-- /wp:paragraph -->\n(Calcule X = nb_mots_article / 200, arrondi au supérieur.)`
      : '';

    const keyTakeawaysBlock = opts.key_takeaways
      ? `### ${stepNum++}. POINTS CLÉS À RETENIR — juste après le temps de lecture (ou en premier si pas de temps de lecture)\n<!-- wp:group {"className":"key-takeaways"} --><div class="wp-block-group"><h3><i class="fa-solid fa-lightbulb"></i> Points clés à retenir</h3><ul class="wp-block-list"><li>...</li></ul></div><!-- /wp:group -->\n(3-4 points. Commence chaque point par un <strong>mot-clé en gras</strong>. Répond directement à l'intention de recherche.)`
      : '';

    const readingTimeRule = [readingTimeBlock, keyTakeawaysBlock].filter(Boolean).join('\n\n') ||
      '### 1. PREMIER ÉLÉMENT — commence directement le corps de l\'article sans intro générique.';

    const tocRule = opts.table_of_contents
      ? `### ${stepNum++}. SOMMAIRE — utilise UNIQUEMENT ce shortcode Gutenberg (ne jamais coder le sommaire en HTML) :\n<!-- wp:shortcode -->[ez-toc]<!-- /wp:shortcode -->`
      : '';

    const faqRule = opts.faq
      ? `### SECTION FAQ (fin d'article, avant la conclusion)\nFormat exact à respecter :\n<!-- wp:heading {"level":2} --><h2 class="wp-block-heading"><i class="fa-solid fa-circle-question"></i> Questions fréquentes</h2><!-- /wp:heading -->\nPour chaque Q/R :\n<!-- wp:paragraph --><p><strong><i class="fa-solid fa-circle-question"></i> La question ?</strong></p><!-- /wp:paragraph -->\n<!-- wp:paragraph --><p>La réponse concise en 2-3 phrases.</p><!-- /wp:paragraph -->`
      : '';

    const writingInstructionsBlock = opts.writing_instructions
      ? `## Instructions Rédaction Personnalisées\n${opts.writing_instructions}`
      : '';

    const humanizationLevel = persona.humanization_level || 'medium';
    const humanizationInstructionsBlock = {
      low: `**Niveau LOW** : Élimine uniquement les formules robotiques. Phrases directes. Ton fidèle au PERSONA défini ci-dessus.`,
      medium: `**Niveau MEDIUM** :
- Exprime-toi avec les **Expressions favorites** et les **Particularités** définies dans TON IDENTITÉ ci-dessus
- Varie la longueur des phrases (courtes percutantes + longues explicatives)
- Glisse 3-5 reformulations spontanées cohérentes avec le ton du PERSONA
- Inclus 1-2 questions rhétoriques adressées au lecteur`,
      high: `**Niveau HIGH** :
- Incarne pleinement le PERSONA : chaque phrase doit refléter ses **Expressions favorites**, son **Ton** et ses **Particularités**
- Permets-toi des phrases débutant par une conjonction, des parenthèses conversationnelles, dans le style propre au PERSONA
- Intègre 1-2 anecdotes ou observations de terrain cohérentes avec le **Background** et la **Spécialité** du PERSONA
- Petites auto-corrections ou apartés dans la voix du PERSONA`
    }[humanizationLevel] || '';

    const writerPrompt = CUSTOM_WRITER_PROMPT
      .replace('{{language_block}}', languageBlock)
      .replace('{{strategic_brief}}', JSON.stringify(strategicBrief, null, 2))
      .replace('{{persona_nom}}', persona.name || 'Expert')
      .replace('{{persona_background}}', persona.background || '')
      .replace('{{persona_specialite}}', persona.specialty || '')
      .replace('{{persona_ton}}', persona.tone || 'Professionnel')
      .replace('{{persona_tics_langage}}', persona.tics || '')
      .replace('{{persona_particularites}}', persona.particularities || '')
      .replace('{{persona_utilise_je}}', persona.use_first_person ? 'Oui (Utilise "Je")' : 'Non (Reste impersonnel)')
      .replace('{{humanization_level}}', persona.humanization_level || 'medium')
      .replace('{{options_json}}', JSON.stringify(opts, null, 2))
      .replace('{{current_date}}', currentDate)
      .replace('{{target_length}}', targetLength)
      .replace('{{reading_time_rule}}', readingTimeRule)
      .replace('{{toc_rule}}', tocRule)
      .replace('{{faq_rule}}', faqRule)
      .replace('{{writing_instructions_block}}', writingInstructionsBlock)
      .replace('{{humanization_instructions_block}}', humanizationInstructionsBlock);

    let aiOutput = await generateWithLLM(writerPrompt, writingModel).then(raw => parseAiJson(raw));

    // Phase 2b : patch sections manquantes (si nécessaire, modèle économique)
    if (aiOutput._missing_sections && aiOutput._missing_sections.length > 0) {
      console.warn(`  ⚠️ Sections manquantes: ${aiOutput._missing_sections.join(', ')} — patch...`);
      const patchPrompt = `L'article suivant manque ces sections : ${aiOutput._missing_sections.join(', ')}.
Brief stratégique original : ${JSON.stringify(strategicBrief, null, 2)}
HTML existant : ${aiOutput.html}
Rédige UNIQUEMENT les blocs Gutenberg manquants (pas le JSON complet, juste le HTML des sections). Date : ${currentDate}.`;

      const patchedHtml = await generateWithLLM(patchPrompt, writingModel);
      // Injecte les sections patchées avant la FAQ si elle existe
      const faqMarker = aiOutput.html.includes('<h2') ? aiOutput.html.lastIndexOf('<!-- wp:heading') : aiOutput.html.length;
      aiOutput.html = aiOutput.html.substring(0, faqMarker) + patchedHtml + aiOutput.html.substring(faqMarker);
    }

    let finalHtml = (aiOutput.html || '').replace(/\{[\s\S]*?"@context":\s*"https:\/\/schema\.org"[\s\S]*?\}/gi, '').trim();

    if (!finalHtml || finalHtml.trim().length < 100) {
      throw new Error('Contenu généré vide ou trop court — publication annulée.');
    }

    // Injection FAQ JSON-LD
    if (opts.faq_jsonld && aiOutput.faq && aiOutput.faq.length > 0) {
      console.log('  ❓ Ajout du FAQ Schema (JSON-LD)...');
      const faqItems = aiOutput.faq.map(f => ({
        '@type': 'Question',
        'name': f.question,
        'acceptedAnswer': { '@type': 'Answer', 'text': f.answer },
      }));
      finalHtml += `\n<!-- wp:html -->\n<script type="application/ld+json">\n${JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        'mainEntity': faqItems,
      }, null, 2)}\n</script>\n<!-- /wp:html -->\n`;
    }

    // ── PHASE 3 : Médias (Runware, en parallèle) ──────────────────────────
    console.log('🖼️ [CUSTOM] Phase 3: Génération des médias...');

    const featuredImageStyle = opts.featured_image_style || 'photorealistic';
    const stylePhotos = { photorealistic: ', photorealistic, 4k, sharp focus', cartoon: ', cartoon style, flat illustration, vibrant colors', illustration: ', digital illustration, artistic style', drawing: ', hand drawn illustration, sketch style' };
    const styleSuffix = stylePhotos[featuredImageStyle] || '';

    const featuredPrompt = (aiOutput.metadata.image_generation_prompt || `${keyword}, professional photo`) + styleSuffix;

    // Prépare les prompts images de section + alt texts
    const sectionImagePrompts = [];
    const sectionImageAltTexts = [];
    const sectionStyle = stylePhotos[opts.section_image_style] || '';
    if (sectionImgCount > 0 && strategicBrief.section_image_prompts) {
      for (let i = 0; i < sectionImgCount; i++) {
        const p = strategicBrief.section_image_prompts[i];
        if (p) {
          sectionImagePrompts.push(p + sectionStyle);
          // Alt text SEO en français fourni par l'analyst — fallback sur keyword si absent
          const seoAlt = (strategicBrief.section_image_alts || [])[i];
          sectionImageAltTexts.push(seoAlt ? seoAlt.substring(0, 120) : keyword);
        }
      }
    }
    console.log(`  🎨 Style images de section: "${opts.section_image_style || 'photorealistic'}" (suffixe: "${sectionStyle || 'aucun'}")`);
    console.log(`  🎨 Style image principale: "${featuredImageStyle}" (suffixe: "${styleSuffix || 'aucun'}"`);

    // Modèle infographie
    const infographicRunwareModel = opts.infographic_model === 'flux' ? 'runware:400@1' : 'google:4@3';

    // Lancement parallèle de toutes les images
    // noDefaultStyle=true : le style est déjà dans le prompt via styleSuffix/sectionStyle
    const mediaPromises = [
      generateRunwareImage(featuredPrompt, 'photo', 3, null, true),
      ...(opts.infographic && strategicBrief.infographic_prompt
        ? [generateRunwareImage(strategicBrief.infographic_prompt, 'infographic', 3, infographicRunwareModel)]
        : [Promise.resolve(null)]),
      ...sectionImagePrompts.map(p => generateRunwareImage(p, 'photo', 3, null, true)),
    ];

    const [featuredImageUrl, infographicUrl, ...sectionImageUrls] = await Promise.all(mediaPromises);

    // ── PHASE 4 : Publication ──────────────────────────────────────────────
    console.log('📤 [CUSTOM] Phase 4: Publication WordPress...');

    const isBridgeMode = site.connection_mode === 'bridge_plugin';

    // Upload des images de section vers WordPress (ou URL directe en mode Bridge)
    if (sectionImageUrls.length > 0) {
      const uploadedSectionUrls = await Promise.all(
        sectionImageUrls.map(async (url, idx) => {
          if (!url) return null;
          if (isBridgeMode) return url; // Bridge : le plugin gère le sideload
          try {
            const media = await uploadImageToWordPress(
              site.url, site.wp_user, wpPassword,
              url, `${keyword} — image ${idx + 1}`,
              'rest_api', site.bridge_key
            );
            return media?.url || url;
          } catch {
            console.warn(`  ⚠️ Upload image section ${idx + 1} échoué — URL Runware utilisée en fallback`);
            return url;
          }
        })
      );
      finalHtml = injectSectionImages(finalHtml, uploadedSectionUrls, sectionImageAltTexts);
    }
    const infographicAlt = `Infographie : ${keyword}`;

    // Traitement infographie
    if (infographicUrl) {
      let infoImgSrc = null;
      if (isBridgeMode) {
        infoImgSrc = infographicUrl;
      } else {
        const infoMedia = await uploadImageToWordPress(site.url, site.wp_user, wpPassword, infographicUrl, infographicAlt, 'rest_api', site.bridge_key);
        if (infoMedia?.url) infoImgSrc = infoMedia.url;
      }

      if (infoImgSrc) {
        const imgHtml = `\n<!-- wp:image {"sizeSlug":"large"} --><figure class="wp-block-image size-large"><img src="${infoImgSrc}" alt="${infographicAlt}"/></figure><!-- /wp:image -->\n`;
        const parts = finalHtml.split(/<h2/i);
        finalHtml = parts.length > 2
          ? parts[0] + '<h2' + parts[1] + imgHtml + parts.slice(2).map(p => '<h2' + p).join('')
          : finalHtml + imgHtml;
      }
    }

    const categories = await getCategories(site);
    const categoryId = await classifyArticle(aiOutput.metadata.title, aiOutput.metadata.excerpt, categories);

    const featuredMedia = await uploadImageToWordPress(
      site.url, site.wp_user, wpPassword,
      featuredImageUrl, aiOutput.metadata.title,
      site.connection_mode, site.bridge_key
    );

    const pubResult = await publishPost({ ...site, wp_password: wpPassword }, {
      title: aiOutput.metadata.title,
      content: finalHtml,
      excerpt: aiOutput.metadata.excerpt,
      slug: aiOutput.metadata.slug,
      status: job.custom_status || site.default_status || 'draft',
      categories: [categoryId],
      featured_media_id: featuredMedia?.id,
      featured_media_url: featuredMedia?.url || featuredImageUrl,
      date: job.scheduled_at || null,
      infographic_url: infographicUrl || null,
      infographic_alt: infographicUrl ? infographicAlt : null,
    });

    await supabase.from('articles_queue').update({
      status: 'published',
      processed_at: new Date(),
      published_title: aiOutput.metadata.title,
      published_url: pubResult.link,
    }).eq('id', jobId);

    await enqueueSocialPost(site.id, jobId, 'seo', job.scheduled_at);

    if (pubResult.id) {
      await upsertToWpCache({
        userId: site.user_id,
        wordpressSiteId: site.id,
        wpPostId: pubResult.id,
        title: aiOutput.metadata.title,
        slug: aiOutput.metadata.slug,
        link: pubResult.link,
        status: job.custom_status || site.default_status || 'draft',
        postDate: job.scheduled_at || new Date().toISOString(),
      });
    }

    console.log(`✅ [CUSTOM] Succès : ${pubResult.link}`);
    process.exit(0);

  } catch (error) {
    console.error(`❌ [CUSTOM] Erreur : ${error.message}`);
    if (creditsSpent > 0) await refundCredit(site.user_id, creditsSpent, jobId);
    await supabase.from('articles_queue').update({ status: 'failed', error_message: error.message }).eq('id', jobId);
    process.exit(1);
  }
}

runCustomJob();
