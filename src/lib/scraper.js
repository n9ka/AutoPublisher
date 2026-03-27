const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Récupère le contenu principal d'une page web (titre + texte)
 */
async function scrapeArticle(url) {
  // Nettoyage de l'URL pour supprimer les caractères parasites à la fin (typos de logs, etc.)
  const cleanUrl = url.trim().replace(/[:;.,]+$/, '');

  try {
    const { data } = await axios.get(cleanUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://www.google.com/',
        'Sec-Ch-Ua': '"Not A(Brand";v="99", "Google Chrome";v="121", "Chromium";v="121"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
        'Sec-Fetch-User': '?1',
        'Upgrade-Insecure-Requests': '1'
      },
      timeout: 15000
    });

    const $ = cheerio.load(data);

    // Nettoyage basique (scripts, styles, pubs communes)
    $('script, style, nav, footer, iframe, .ad, .advertisement, .social-share').remove();

    // Extraction Titre
    const title = $('h1').first().text().trim() || $('title').text().trim();

    // Extraction Contenu : on vise les balises article ou main, sinon fallback body
    let contentEl = $('article');
    if (contentEl.length === 0) contentEl = $('main');
    if (contentEl.length === 0) contentEl = $('.post-content, .entry-content, .content'); // Classiques WP
    if (contentEl.length === 0) contentEl = $('body');

    // Récupérer le texte structuré (paragraphes)
    // On garde un peu de structure pour que le LLM comprenne
    const paragraphs = [];
    contentEl.find('p, h2, h3, li').each((i, el) => {
      const text = $(el).text().trim();
      if (text.length > 20) { // Filtrer les trucs trop courts (boutons, menus)
        paragraphs.push(text);
      }
    });

    const fullText = paragraphs.join('\n\n');

    return {
      title,
      content: fullText,
      url
    };

  } catch (error) {
    console.error(`  ❌ Erreur lors du scrap de [${cleanUrl}] ->`, error.message);
    return null;
  }
}

module.exports = { scrapeArticle };
