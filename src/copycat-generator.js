// copycat-generator.js — Mode Copycat
// Pipeline : Scrape URL → Recherche fresh data → Réécriture persona → Images → Publication
require('dotenv').config();
const cheerio = require('cheerio');
const { supabase } = require('./lib/supabase');
const { searchBrave } = require('./lib/research');
const { researchWithTavily, extractWithTavily } = require('./lib/tavily');
const { buildLanguageBlock } = require('./lib/languages');
const { generateContent } = require('./lib/deepseek');
const { generateRunwareImage } = require('./lib/runware');
const { uploadImageToWordPress, publishPost, getCategories } = require('./lib/wordpress');
const { decrypt } = require('./lib/encryption');
const { spendCredit, refundCredit } = require('./lib/credits');
const { upsertToWpCache } = require('./lib/supabase-data');
const { classifyArticle } = require('./lib/gemini');
const { enqueueSocialPost } = require('./lib/social/enqueue');
const { sendTelegram } = require('./lib/telegram');
const { getDeepSeekPeakTelegramNote } = require('./lib/deepseek-pricing');
const { COPYCAT_WRITER_PROMPT } = require('./prompts/copycat-writer');
const { repairJson, repairJsonWithAI } = require('./lib/json-helper');

const COPYCAT_CREDITS = 6;
const DEEPSEEK_MODEL = 'deepseek-v4-flash';

async function parseAiJson(text) {
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
  try {
    const { json: fixed, isTruncated } = repairJson(jsonStr);
    const parsed = JSON.parse(fixed);
    parsed._isTruncated = isTruncated;
    return parsed;
  } catch (e) {
    console.warn('⚠️ Réparation locale échouée, tentative OpenRouter...');
    const fixedStr = await repairJsonWithAI(jsonStr);
    const parsed = JSON.parse(fixedStr);
    parsed._isTruncated = false;
    parsed._jsonRepaired = true;
    console.log('  ✅ Réparation IA réussie.');
    return parsed;
  }
}

function injectSectionImages(html, sectionImageUrls, altTexts = []) {
  let result = html;
  sectionImageUrls.forEach((url, idx) => {
    if (!url) return;
    const marker = `<!-- SECTION_IMAGE_${idx + 1} -->`;
    const alt = (altTexts[idx] || '').replace(/"/g, '&quot;').substring(0, 120);
    const block = `\n<!-- wp:image {"sizeSlug":"large"} --><figure class="wp-block-image size-large"><img src="${url}" alt="${alt}"/></figure><!-- /wp:image -->\n`;
    result = result.replace(marker, block);
  });
  result = result.replace(/<!-- SECTION_IMAGE_\d+ -->/g, '');
  return result;
}

function injectSectionImagesByH2(html, imageUrls, altTexts, headingMarker) {
  const parts = html.split(headingMarker);
  const totalSections = parts.length - 1;
  const validUrls = imageUrls.filter(Boolean);
  if (totalSections === 0 || validUrls.length === 0) return html;

  const imgCount = Math.min(validUrls.length, totalSections);
  const chosenMap = new Map();
  for (let i = 0; i < imgCount; i++) {
    const pos = Math.round(i * (totalSections - 1) / Math.max(imgCount - 1, 1));
    const partsIdx = Math.min(pos + 1, totalSections);
    if (!chosenMap.has(partsIdx)) chosenMap.set(partsIdx, i);
  }

  return parts.map((part, i) => {
    const prefix = i === 0 ? '' : headingMarker;
    const imgIdx = chosenMap.get(i);
    if (imgIdx !== undefined && validUrls[imgIdx]) {
      const alt = (altTexts[imgIdx] || '').replace(/"/g, '&quot;').substring(0, 120);
      return prefix + part + `\n<!-- wp:image {"sizeSlug":"large"} --><figure class="wp-block-image size-large"><img src="${validUrls[imgIdx]}" alt="${alt}"/></figure><!-- /wp:image -->\n`;
    }
    return prefix + part;
  }).join('');
}

async function fetchHtml(url, attempt = 1) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    if (attempt < 2 && err.name !== 'AbortError') {
      console.warn(`  ⚠️ Fetch échoué (tentative ${attempt}), retry dans 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      return fetchHtml(url, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function scrapeUrl(url) {
  console.log(`  🌐 Scraping : ${url}`);

  // Tentative 1 : fetch direct avec headers navigateur
  let usedFallback = false;
  let title = '';
  let text = '';

  try {
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    $('script, style, nav, header, footer, aside, iframe, noscript, [class*="sidebar"], [class*="menu"], [class*="cookie"], [class*="popup"], [id*="sidebar"], [id*="menu"]').remove();
    title = $('h1').first().text().trim() || $('title').text().trim() || '';
    const selectors = [
      '.entry-content', '.post-content', '.article-content', '.article-body',
      'article', 'main', '.content', '#content', '#main', 'body',
    ];
    for (const sel of selectors) {
      const candidate = $(sel).first().text().replace(/\s+/g, ' ').trim();
      if (candidate.length >= 400) {
        text = candidate.substring(0, 50000);
        break;
      }
    }
  } catch (fetchErr) {
    console.warn(`  ⚠️ Fetch direct échoué (${fetchErr.message}), fallback Tavily Extract...`);
  }

  // Tentative 2 : Tavily Extract si fetch bloqué ou contenu insuffisant
  if (!text) {
    usedFallback = true;
    const tavilyText = await extractWithTavily(url);
    if (tavilyText && tavilyText.length >= 400) {
      text = tavilyText.substring(0, 50000);
      title = title || url;
    }
  }

  if (!text) {
    throw new Error('Contenu inaccessible — site protégé (Cloudflare, paywall, SPA sans SSR) et Tavily Extract a échoué.');
  }

  console.log(`  ✅ Scrape OK ${usedFallback ? '[via Tavily Extract]' : ''} — ${text.length} chars, titre: "${title}"`);
  return { title, text };
}

async function runCopycatJob() {
  const jobId = process.argv[2];
  if (!jobId) {
    console.error('❌ Aucun ID de job fourni.');
    process.exit(1);
  }

  console.log(`🚀 [COPYCAT] Démarrage du Job: ${jobId}`);

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
  const opts = job.custom_options || {};
  const sourceUrl = opts.url || job.source_url;

  if (!sourceUrl) {
    console.error('❌ URL source manquante dans custom_options.url');
    process.exit(1);
  }

  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    const [encrypted, authTag] = site.wp_password.split(':');
    wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
  }

  await supabase
    .from('articles_queue')
    .update({ status: 'processing', processing_started_at: new Date() })
    .eq('id', jobId);

  let creditsSpent = 0;
  const currentDate = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
  const outputLanguage = opts.output_language || site.default_language || 'fr';
  const languageBlock = buildLanguageBlock(outputLanguage);

  const langLabels = {
    fr: 'FRANÇAIS',
    fr_BE: 'FRANÇAIS (BELGIQUE)',
    en: 'ENGLISH',
    nl_BE: 'NEDERLANDS (BELGIË)',
    es: 'ESPAÑOL',
    de: 'DEUTSCH',
    it: 'ITALIANO',
    pt: 'PORTUGUÊS',
  };
  const outputLanguageLabel = langLabels[outputLanguage] || 'FRANÇAIS';

  try {
    await spendCredit(site.user_id, COPYCAT_CREDITS, jobId);
    creditsSpent = COPYCAT_CREDITS;
    console.log(`  💳 ${COPYCAT_CREDITS} crédits débités.`);

    // ── SCRAPING ────────────────────────────────────────────────────────────
    console.log('🔍 [COPYCAT] Scraping de la source...');
    const scraped = await scrapeUrl(sourceUrl);

    // Mot-clé de recherche : titre > source_title > slug URL > hostname
    const urlSlug = new URL(sourceUrl).pathname.replace(/^\/|\/$/g, '').split('/').pop()?.replace(/-/g, ' ').trim();
    const searchKeyword = (scraped.title || job.source_title || urlSlug || new URL(sourceUrl).hostname).substring(0, 120);

    // ── RECHERCHE PARALLÈLE ──────────────────────────────────────────────────
    console.log(`🔍 [COPYCAT] Enrichissement : recherche parallèle sur "${searchKeyword}"...`);
    const [braveResults, tavilyResults] = await Promise.all([
      searchBrave(searchKeyword, false, outputLanguage),
      researchWithTavily(searchKeyword),
    ]);

    // ── RÉDACTION ────────────────────────────────────────────────────────────
    console.log(`✍️ [COPYCAT] Rédaction (${DEEPSEEK_MODEL})...`);
    const persona = site.persona || {};

    const sourceWordCount = scraped.text.split(/\s+/).length;
    const targetWordCount = Math.max(1200, Math.round(sourceWordCount * 1.1));

    const writerPrompt = COPYCAT_WRITER_PROMPT
      .replace('{{target_word_count}}', targetWordCount)
      .replace('{{language_block}}', languageBlock)
      .replace('{{persona_nom}}', persona.name || 'Expert')
      .replace('{{persona_background}}', persona.background || '')
      .replace('{{persona_specialite}}', persona.specialty || '')
      .replace('{{persona_ton}}', persona.tone || 'Professionnel')
      .replace('{{persona_tics_langage}}', persona.tics || '')
      .replace('{{persona_utilise_je}}', persona.use_first_person ? 'Oui (Utilise "Je")' : 'Non (Reste impersonnel)')
      .replace('{{persona_particularites}}', persona.particularities || '')
      .replace('{{humanization_level}}', persona.humanization_level || 'medium')
      .replace('{{current_date}}', currentDate)
      .replace('{{output_language_label}}', outputLanguageLabel)
      .replace('{{source_content}}', scraped.text)
      .replace('{{brave_results}}', braveResults || 'Aucun résultat disponible')
      .replace('{{tavily_results}}', tavilyResults || 'Aucun résultat disponible');

    const rawOutput = await generateContent(writerPrompt, DEEPSEEK_MODEL);
    let aiOutput = await parseAiJson(rawOutput);

    const wp = aiOutput.wordpress || aiOutput;
    let finalHtml = (wp.content || wp.html || '').replace(/<script[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi, '').replace(/\\n/g, '\n').trim();

    if (!finalHtml || finalHtml.length < 100) {
      throw new Error('Contenu généré vide ou trop court.');
    }

    const sectionImagePrompts = (aiOutput.section_image_prompts || []).slice(0, 2);
    const sectionImageAlts = (aiOutput.section_image_alts || []).slice(0, 2);

    // Complète si le LLM n'a pas fourni 2 prompts
    while (sectionImagePrompts.length < 2) {
      sectionImagePrompts.push(`${searchKeyword}, professional photography, textless, single subject`);
    }
    while (sectionImageAlts.length < 2) {
      sectionImageAlts.push(searchKeyword.substring(0, 80));
    }

    // ── MÉDIAS (parallèle) ──────────────────────────────────────────────────
    console.log('🖼️ [COPYCAT] Génération des médias (1 featured + 2 sections)...');
    const featuredPrompt = (wp.image_generation_prompt || `${searchKeyword}, professional photo`);

    const [featuredImageUrl, sectionImg1Url, sectionImg2Url] = await Promise.all([
      generateRunwareImage(featuredPrompt, 'photo', 3, null, true),
      generateRunwareImage(sectionImagePrompts[0], 'photo', 3, null, true),
      generateRunwareImage(sectionImagePrompts[1], 'photo', 3, null, true),
    ]);

    const sectionImageUrls = [sectionImg1Url, sectionImg2Url];

    // ── INJECTION IMAGES DE SECTION ─────────────────────────────────────────
    console.log('📤 [COPYCAT] Injection des images...');
    const HEADING_MARKER = '<!-- wp:heading {"level":2}';
    const hasMarkers = /<!-- SECTION_IMAGE_\d+ -->/.test(finalHtml);

    const sectionReplaceMap = [];
    let wafBlocked = false;
    const uploadedSectionUrls = [];

    for (let idx = 0; idx < sectionImageUrls.length; idx++) {
      const url = sectionImageUrls[idx];
      if (!url) { uploadedSectionUrls.push(null); continue; }
      let media = null;
      if (!wafBlocked) {
        media = await uploadImageToWordPress(
          site.url, site.wp_user, wpPassword,
          url, sectionImageAlts[idx] || `${searchKeyword} — image ${idx + 1}`,
          site.connection_mode, site.bridge_key
        );
        if (media?.is_bridge) wafBlocked = true;
      }
      if (!media?.url || media?.is_bridge) {
        sectionReplaceMap.push({ url, alt: sectionImageAlts[idx] || '' });
        uploadedSectionUrls.push(url);
      } else {
        uploadedSectionUrls.push(media.url);
      }
    }

    if (hasMarkers) {
      finalHtml = injectSectionImages(finalHtml, uploadedSectionUrls, sectionImageAlts);
    } else {
      finalHtml = injectSectionImagesByH2(finalHtml, uploadedSectionUrls, sectionImageAlts, HEADING_MARKER);
    }

    // ── PUBLICATION ──────────────────────────────────────────────────────────
    console.log('📤 [COPYCAT] Publication WordPress...');
    const categories = await getCategories({ ...site, wp_password: wpPassword });
    const categoryId = await classifyArticle(wp.title, wp.excerpt, categories);

    const featuredMedia = wafBlocked ? null : await uploadImageToWordPress(
      site.url, site.wp_user, wpPassword,
      featuredImageUrl, wp.title,
      site.connection_mode, site.bridge_key
    );

    const pubResult = await publishPost({ ...site, wp_password: wpPassword }, {
      title: wp.title,
      content: finalHtml,
      excerpt: wp.excerpt,
      slug: wp.slug,
      keywords: wp.keywords,
      status: job.custom_status || site.default_status || 'draft',
      categories: [categoryId],
      featured_media_id: featuredMedia?.id,
      featured_media_url: featuredMedia?.url || featuredImageUrl,
      date: job.scheduled_at || null,
      section_image_urls: sectionReplaceMap.length > 0 ? sectionReplaceMap : undefined,
    });

    await supabase.from('articles_queue').update({
      status: 'published',
      processed_at: new Date(),
      published_title: wp.title,
      published_url: pubResult.link,
    }).eq('id', jobId);

    await enqueueSocialPost(site.id, jobId, 'seo', job.scheduled_at);

    if (pubResult.id) {
      await upsertToWpCache({
        userId: site.user_id,
        wordpressSiteId: site.id,
        wpPostId: pubResult.id,
        title: wp.title,
        slug: wp.slug,
        link: pubResult.link,
        status: job.custom_status || site.default_status || 'draft',
        postDate: job.scheduled_at || new Date().toISOString(),
      });
    }

    console.log(`✅ [COPYCAT] Succès : ${pubResult.link}`);
    const repairNote = aiOutput._jsonRepaired ? '\n⚠️ JSON réparé par IA' : '';
    await sendTelegram(`✅ <b>[COPYCAT]</b> Article publié\n• <a href="${pubResult.link}">${wp.title}</a>\n• ${site.name}${repairNote}${getDeepSeekPeakTelegramNote()}`);
    process.exit(0);

  } catch (error) {
    console.error(`❌ [COPYCAT] Erreur : ${error.message}`);
    if (creditsSpent > 0) await refundCredit(site.user_id, creditsSpent, jobId);
    await supabase.from('articles_queue').update({ status: 'failed', error_message: error.message }).eq('id', jobId);
    await sendTelegram(`❌ <b>[COPYCAT]</b> Échec\n• ${job?.source_title || sourceUrl || jobId}\n• ${site?.name || '?'}\n└ ${error.message}`);
    process.exit(1);
  }
}

runCopycatJob();
