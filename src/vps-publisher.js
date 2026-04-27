/**
 * vps-publisher.js — Publication WordPress depuis le VPS (sans Supabase)
 *
 * Récupère les credentials WP via l'API Aspy.fr, puis publie l'article
 * généré par /aspy-rediger (fichiers HTML + JSON dans Workflow-Entreprise/output/).
 *
 * Usage:
 *   node vps-publisher.js --site="cafel.fr" --slug="mon-article" [--status=draft|publish] [--date="2026-04-25"]
 *
 * Env requis: CATALOGUE_API_KEY, ASPY_API_URL, RUNWARE_API_KEY (ou PEXELS_API_KEY), GEMINI_API_KEY
 *
 * À déployer sur le VPS avec la structure :
 *   ~/aspy-bot/
 *     vps-publisher.js        ← ce fichier
 *     lib/wordpress.js        ← copié depuis AutoPublisher/src/lib/wordpress.js
 *     lib/runware.js          ← copié depuis AutoPublisher/src/lib/runware.js
 *     .env
 *     package.json
 */
require('dotenv').config();

const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { uploadImageToWordPress, publishPost, getCategories } = require('./lib/wordpress');
const { generateRunwareImage } = require('./lib/runware');

const OUTPUT_DIR = path.join(__dirname, '../../Workflow-Entreprise/output');

async function sendTelegram(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.warn('⚠️  Telegram notification échouée:', e.message);
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  const get = (key) => {
    const found = args.find(a => a.startsWith(`--${key}=`));
    return found ? found.split('=').slice(1).join('=') : null;
  };
  const dateArg = get('date');
  const status = dateArg ? 'future' : (get('status') || 'draft');
  let scheduledDate = null;
  if (dateArg) {
    const d = new Date(`${dateArg}T09:00:00`);
    if (isNaN(d.getTime())) {
      console.error(`Date invalide : ${dateArg}. Format attendu : YYYY-MM-DD`);
      process.exit(1);
    }
    scheduledDate = d.toISOString().slice(0, 19);
  }
  return { site: get('site'), slug: get('slug'), status, scheduledDate };
}

async function fetchSiteConfig(siteArg) {
  const apiUrl = process.env.ASPY_API_URL || 'https://aspy.fr';
  const apiKey = process.env.CATALOGUE_API_KEY;
  if (!apiKey) throw new Error('CATALOGUE_API_KEY manquant dans .env');

  const res = await axios.get(`${apiUrl}/api/vps/site-config`, {
    params: { site: siteArg },
    headers: { 'x-api-key': apiKey },
    timeout: 10000,
  });
  return res.data;
}

const GENERIC_CAT_RE = /actualit|divers|g[eé]n[eé]ral|news|autres|uncategor|non.?class/i;

async function classifyCategory(title, excerpt, categories) {
  const apiKey = process.env.GEMINI_API_KEY;
  const fallbackCat = categories.find(c => GENERIC_CAT_RE.test(c.name) || c.id === 1) ?? categories[0];
  if (!apiKey || categories.length === 0) return fallbackCat?.id ?? 1;

  const validIds = new Set(categories.map(c => c.id));
  const catList = categories.map(c => {
    let fullName = c.name;
    if (c.parent && c.parent !== 0) {
      const parent = categories.find(p => p.id === c.parent);
      if (parent) fullName = `${parent.name} > ${c.name}`;
    }
    const isGeneric = c.id === 1 || GENERIC_CAT_RE.test(c.name);
    return { id: c.id, name: fullName, ...(isGeneric && { dernier_recours: true }) };
  });

  const prompt = `Tu es un expert WordPress. Choisis l'ID de la catégorie la plus pertinente pour cet article.
TITRE: "${title}"
RESUME: "${excerpt}"
CATEGORIES DISPONIBLES: ${JSON.stringify(catList)}
RÈGLE : Choisis toujours une catégorie thématique précise. N'utilise une catégorie marquée "dernier_recours" que si vraiment aucune autre ne correspond.
Réponds UNIQUEMENT avec l'ID numérique choisi.`;

  try {
    const res = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`,
      { contents: [{ parts: [{ text: prompt }] }] },
      { timeout: 15000 }
    );
    const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    const id = parseInt(text.match(/\d+/)?.[0]);
    return (id && validIds.has(id)) ? id : fallbackCat?.id ?? 1;
  } catch (err) {
    console.warn(`⚠️  Classification échouée (${err.message}) — catégorie par défaut.`);
    return fallbackCat?.id ?? 1;
  }
}

async function fetchPexelsImage(keyword) {
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) return null;
  try {
    const res = await axios.get('https://api.pexels.com/v1/search', {
      headers: { Authorization: apiKey },
      params: { query: keyword, per_page: 1, orientation: 'landscape' },
      timeout: 10000,
    });
    return res.data?.photos?.[0]?.src?.large2x ?? null;
  } catch {
    return null;
  }
}

async function main() {
  const { site: siteArg, slug, status, scheduledDate } = parseArgs();

  if (!siteArg || !slug) {
    console.error('Usage: node vps-publisher.js --site="domain.fr" --slug="article-slug" [--status=draft|publish] [--date="2026-04-25"]');
    process.exit(1);
  }

  // 1. Lire les fichiers output
  const htmlPath = path.join(OUTPUT_DIR, `${slug}.html`);
  const jsonPath = path.join(OUTPUT_DIR, `${slug}.json`);
  if (!fs.existsSync(htmlPath) || !fs.existsSync(jsonPath)) {
    console.error(`Fichiers introuvables : ${htmlPath} ou ${jsonPath}`);
    process.exit(1);
  }
  const htmlContent = fs.readFileSync(htmlPath, 'utf8');
  const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  const metadata = jsonData.metadata;
  console.log(`📄 Article : "${metadata.title}" (${slug})`);

  // 2. Récupérer les credentials WP depuis l'API Aspy.fr
  console.log('🔑 Récupération credentials...');
  let site;
  try {
    site = await fetchSiteConfig(siteArg);
  } catch (err) {
    console.error(`❌ Impossible de récupérer les credentials : ${err.message}`);
    process.exit(1);
  }
  console.log(`🌐 Site : ${site.wp_url} (mode: ${site.connection_mode})`);

  const siteConfig = {
    url: site.wp_url,
    wp_user: site.wp_user,
    wp_password: site.wp_password,
    connection_mode: site.connection_mode,
    bridge_key: site.bridge_key,
  };

  // 3. Classifier la rubrique
  console.log('🗂️  Classification rubrique...');
  let categoryId = null;
  try {
    const wpCategories = await getCategories(siteConfig);
    categoryId = await classifyCategory(metadata.title, metadata.excerpt || '', wpCategories);
    console.log(`   → Rubrique ID: ${categoryId}`);
  } catch (err) {
    console.warn(`⚠️  Classification ignorée : ${err.message}`);
  }

  // 4. Générer l'image à la une
  const imagePrompt = metadata.imagePrompt || metadata.image_generation_prompt;
  const imageAlt = metadata.imagePromptAlt || metadata.title;
  let imageUrl = null;

  if (imagePrompt && process.env.RUNWARE_API_KEY) {
    console.log('🎨 Génération image Runware...');
    imageUrl = await generateRunwareImage(imagePrompt, 'photo');
  }

  if (!imageUrl && process.env.PEXELS_API_KEY) {
    console.log('📷 Fallback Pexels...');
    const keyword = (metadata.keywords || metadata.title).split(',')[0].trim();
    imageUrl = await fetchPexelsImage(keyword);
  }

  // 5. Upload image sur WordPress
  let featuredMedia = null;
  if (imageUrl) {
    console.log('⬆️  Upload image WordPress...');
    featuredMedia = await uploadImageToWordPress(
      site.wp_url, site.wp_user, site.wp_password,
      imageUrl, imageAlt,
      site.connection_mode, site.bridge_key
    );
    if (featuredMedia) console.log(`   → Media ID: ${featuredMedia.id}`);
  } else {
    console.warn('⚠️  Aucune image générée — publication sans image à la une.');
  }

  // 6. Publier l'article
  const statusLabel = scheduledDate ? `planifié le ${scheduledDate}` : status;
  console.log(`📤 Publication (${statusLabel})...`);

  const result = await publishPost(siteConfig, {
    title: metadata.title,
    content: htmlContent,
    excerpt: metadata.excerpt || '',
    slug: metadata.slug || slug,
    keywords: metadata.keywords || '',
    status,
    date: scheduledDate,
    categories: categoryId ? [categoryId] : [],
    featured_media_id: featuredMedia?.id || null,
    featured_media_url: featuredMedia?.url || imageUrl || null,
  });

  if (result?.link) {
    const successLabel = scheduledDate ? `Planifié pour le ${scheduledDate}` : 'Publié avec succès';
    console.log(`\n✅ ${successLabel} !`);
    console.log(`🔗 URL : ${result.link}`);
    console.log(`🆔 Post ID : ${result.id}`);

    // Déplacer les fichiers vers output/publie/
    const publishedDir = path.join(OUTPUT_DIR, 'publie');
    if (!fs.existsSync(publishedDir)) fs.mkdirSync(publishedDir, { recursive: true });
    fs.renameSync(htmlPath, path.join(publishedDir, `${slug}.html`));
    fs.renameSync(jsonPath, path.join(publishedDir, `${slug}.json`));
    console.log('📁 Fichiers déplacés → output/publie/');

    // Notification Telegram
    const domain = siteArg.replace(/^https?:\/\//, '').replace(/\/$/, '');
    const statusEmoji = scheduledDate ? '📅' : '✅';
    const statusText = scheduledDate ? `Planifié — ${scheduledDate}` : 'Publié';
    await sendTelegram(
      `${statusEmoji} <b>${statusText}</b>\n` +
      `🌐 ${domain}\n` +
      `📝 ${metadata.title}\n` +
      `🆔 Post ID : ${result.id}\n` +
      `🔗 ${result.link}`
    );
  } else {
    console.error('❌ Échec de publication.');
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Erreur :', err.message);
  process.exit(1);
});
