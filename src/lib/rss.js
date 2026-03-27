const Parser = require('rss-parser');
const axios = require('axios');

/**
 * Lit un flux RSS et retourne les derniers articles normalisés
 */
async function fetchRSS(url, retries = 2) {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36';
  
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Utilisation de axios pour récupérer le contenu
      const response = await axios.get(url, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'application/rss+xml, application/xml, text/xml, */*'
        },
        timeout: 10000
      });

      const parser = new Parser();
      const feed = await parser.parseString(response.data);
      
      return feed.items.map(item => {
        const cleanLink = (item.link || "").trim().replace(/[:;.,]+$/, '');
        return {
          title: item.title,
          link: cleanLink,
          pubDate: item.pubDate ? new Date(item.pubDate) : new Date(),
          contentSnippet: item.contentSnippet || item.content || "",
          guid: item.guid || item.link
        };
      });

    } catch (error) {
      const isLastAttempt = attempt === retries;
      
      if (error.response) {
        if (error.response.status === 403) {
          console.warn(`    ⚠️ [RSS 403] ${url} (Tentative ${attempt}/${retries}) : Accès refusé.`);
        } else {
          console.error(`    ❌ [RSS Error] ${url} : Status ${error.response.status}`);
        }
      } else {
        console.error(`    ❌ [RSS Error] ${url} (Tentative ${attempt}/${retries}) :`, error.message);
      }

      if (isLastAttempt) return [];
      
      // Petit délai avant retry (sauf pour 403 qui est souvent définitif par IP/UA)
      if (error.response && error.response.status === 403) {
        // Pour 403 on ne réessaye pas forcément, mais on peut tenter un délai plus long
        await new Promise(r => setTimeout(r, 2000));
      } else {
        await new Promise(r => setTimeout(r, 1000 * attempt));
      }
    }
  }
  return [];
}

module.exports = { fetchRSS };
