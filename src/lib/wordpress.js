const axios = require('axios');

function getRunnerContext() {
  return process.env.RUNNER_PUBLIC_IP ? ` | runner_ip=${process.env.RUNNER_PUBLIC_IP}` : '';
}

function getHeaderProfile() {
  return (process.env.WP_HEADER_PROFILE || 'default').trim().toLowerCase();
}

/**
 * Génère des headers "humains" ultra-récents pour contourner les WAF (BitNinja 453, Imunify, Cloudflare, etc.)
 */
function getHeaders(baseUrl, auth = null, contentType = 'application/json', bridgeKey = null) {
  const profile = getHeaderProfile();

  const headers = profile === 'safe'
    ? {
        // Profil de test plus prudent :
        // on conserve les headers generiques utiles a la negotiation HTTP,
        // mais on retire ceux qui emulent trop fortement un navigateur.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache'
      }
    : {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Sec-Ch-Ua': '"Not(A:Brand";v="99", "Google Chrome";v="133", "Chromium";v="133"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'empty',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'same-origin',
        'Origin': baseUrl,
        'Referer': baseUrl + '/'
      };

  if (bridgeKey) {
    headers['X-Bridge-Auth'] = bridgeKey;
    headers['Authorization'] = `Bearer ${bridgeKey}`;
  } else if (auth) {
    headers['Authorization'] = `Basic ${auth}`;
  }

  if (contentType) headers['Content-Type'] = contentType;

  return headers;
}

function toPublicLink(link, isHeadless) {
  return isHeadless && link ? link.replace('://cms.', '://') : link;
}

/**
 * Télécharge une image depuis une URL et l'upload sur WordPress
 */
async function uploadImageToWordPress(wpUrl, wpUser, wpPassword, imageUrl, altText, connectionMode = 'rest_api', bridgeKey = null) {
  if (!wpUrl || !imageUrl) return null;
  const baseUrl = wpUrl.replace(/\/$/, '');
  const headerProfile = getHeaderProfile();

  // bridge_deferred : déléguer directement au plugin sans tenter REST
  if (connectionMode === 'bridge_deferred') {
    console.log('  🛡️  Image : Bridge différé, transfert au plugin...');
    return { id: null, url: imageUrl, is_bridge: true };
  }

  const isBridgeMode = connectionMode === 'bridge_plugin';
  if (isBridgeMode) console.log('  🖼️  Image : tentative REST avant Bridge...');
  console.log(`  🧾 Profil headers WP: ${headerProfile}`);

  try {
    const imageResponse = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const buffer = Buffer.from(imageResponse.data, 'binary');
    const filename = `img-${Date.now()}.jpg`;

    const uploadUrl = `${baseUrl}/wp-json/wp/v2/media`;
    const auth = Buffer.from(`${wpUser}:${wpPassword}`).toString('base64');

    const wpResponse = await axios.post(uploadUrl, buffer, {
      headers: {
        ...getHeaders(baseUrl, auth, 'image/jpeg'),
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });

    const mediaId = wpResponse.data.id;
    const localUrl = wpResponse.data.source_url;

    if (altText && mediaId) {
      await axios.post(`${baseUrl}/wp-json/wp/v2/media/${mediaId}`, {
        alt_text: altText
      }, {
        headers: getHeaders(baseUrl, auth)
      });
    }

    if (isBridgeMode) console.log('  ✅  Image uploadée via REST (mode Bridge)');
    return { id: mediaId, url: localUrl };

  } catch (error) {
    const status = error.response ? error.response.status : 0;
    console.error(`Erreur upload image WP: HTTP ${status} | endpoint=${baseUrl}/wp-json/wp/v2/media${getRunnerContext()}`);
    // Mode Bridge : déléguer le sideload au plugin
    if (isBridgeMode) {
      console.log('  🛡️  REST bloqué pour l\'image, délégation au Bridge...');
      return { id: null, url: imageUrl, is_bridge: true };
    }
    // Mode REST standard : fallback Bridge sur erreur WAF
    if ([401, 403, 453].includes(status) && bridgeKey) {
      console.log('  ⚡ Upload bloqué, image différée au Bridge...');
      return { id: null, url: imageUrl, is_bridge: true };
    }
    return null;
  }
}

/**
 * Logique interne de publication pour un mode donné (REST ou Bridge)
 */
async function _doPublish(baseUrl, siteConfig, postData, useBridge) {
  const { wp_user, wp_password, bridge_key } = siteConfig;
  const auth = !useBridge ? Buffer.from(`${wp_user}:${wp_password}`).toString('base64') : null;
  const headerProfile = getHeaderProfile();

  let payload = {
    status: postData.status || 'draft',
    categories: postData.categories || [],
    excerpt: postData.excerpt,
    slug: postData.slug,
    featured_media: postData.featured_media_id,
    date: postData.date || null,
    meta: { internal_links_keywords: postData.keywords || "" }
  };

  let targetUrl = `${baseUrl}/wp-json/wp/v2/posts`;

  if (useBridge) {
    console.log('  🛡️  Utilisation du mode Bridge (Base64 encoding)...');
    const bridgeNs = process.env.WP_BRIDGE_NAMESPACE;
    targetUrl = `${baseUrl}/wp-json/${bridgeNs}/v1/bridge`;
    payload.bridge_key = bridge_key;
    payload.title_base64 = Buffer.from(postData.title).toString('base64');
    payload.content_base64 = Buffer.from(postData.content).toString('base64');
    // Si REST a réussi (media_id présent), le plugin utilise l'ID directement.
    // Sinon on envoie l'URL externe pour que le plugin la sideload.
    if (!postData.featured_media_id && postData.featured_media_url) {
      payload.featured_image_url = postData.featured_media_url;
    }
    if (postData.infographic_url) {
      payload.infographic_image_url = postData.infographic_url;
      payload.infographic_alt_text = postData.infographic_alt || 'Infographie';
    }
    if (postData.section_image_urls && postData.section_image_urls.length > 0) {
      payload.section_image_urls = postData.section_image_urls;
    }
  } else {
    payload.title = postData.title;
    payload.content = postData.content;
  }

  try {
    console.log(`  🧾 Profil headers WP: ${headerProfile}`);
    const response = await axios.post(targetUrl, payload, {
      timeout: 60000,
      headers: getHeaders(baseUrl, auth, 'application/json', useBridge ? bridge_key : null)
    });

    const data = response.data;

    // Valider que la réponse est un objet WP valide avec un post ID.
    // Un 200 avec body HTML (WAF/challenge) ou un objet sans id passerait sinon silencieusement.
    if (!data || typeof data !== 'object' || !data.id || typeof data.id !== 'number' || data.id <= 0) {
      const preview = typeof data === 'string' ? data.slice(0, 200) : JSON.stringify(data);
      const err = new Error(`Réponse WP invalide — post ID absent ou nul. Body: ${preview}`);
      err._httpStatus = response.status;
      throw err;
    }

    const publishedLink = (data.link && typeof data.link === 'string')
      ? data.link
      : `${baseUrl}/?p=${data.id}`;

    return { success: true, id: data.id, link: publishedLink };

  } catch (error) {
    const errorData = error.response ? error.response.data : error.message;
    const status = error._httpStatus || (error.response ? error.response.status : 0);
    console.error(`Erreur publication WP (${useBridge ? 'BRIDGE' : 'REST'}): ${status} | endpoint=${targetUrl}${getRunnerContext()}`);

    const err = new Error(typeof errorData === 'object' ? JSON.stringify(errorData) : (errorData || error.message));
    err._httpStatus = status;
    throw err;
  }
}

/**
 * Publie (ou draft) un article sur WordPress avec fallback automatique
 * - Mode "rest_api"    (API-first)    : tente REST, bascule en Bridge sur 401/403/453 si Bridge configuré
 * - Mode "bridge_plugin" (Bridge-first): tente Bridge, bascule en REST sur toute erreur si REST configuré
 */
async function publishPost(siteConfig, postData) {
  const rawUrl = siteConfig.url || siteConfig.wp_url;
  if (!rawUrl) throw new Error('URL WordPress manquante');
  const baseUrl = rawUrl.replace(/\/$/, '');

  const primaryIsBridge = siteConfig.connection_mode === 'bridge_plugin';

  // Vérifier si le mode secondaire est disponible
  const canFallbackToBridge = !primaryIsBridge && !!siteConfig.bridge_key;
  const canFallbackToRest = primaryIsBridge && !!(siteConfig.wp_user && siteConfig.wp_password);

  try {
    const result = await _doPublish(baseUrl, siteConfig, postData, primaryIsBridge);

    // En mode Bridge, si l'image a été uploadée via REST (media_id disponible),
    // définir l'image à la une via REST après création du post — compatible avec
    // toutes les versions du plugin Bridge sans mise à jour requise.
    if (primaryIsBridge && postData.featured_media_id && result.id) {
      try {
        const auth = Buffer.from(`${siteConfig.wp_user}:${siteConfig.wp_password}`).toString('base64');
        await axios.post(`${baseUrl}/wp-json/wp/v2/posts/${result.id}`,
          { featured_media: postData.featured_media_id },
          { timeout: 10000, headers: getHeaders(baseUrl, auth) }
        );
        console.log('  🖼️  Image à la une définie via REST (mode Bridge)');
      } catch {
        console.warn('  ⚠️  Impossible de définir l\'image à la une via REST après Bridge (non bloquant)');
      }
    }

    result.link = toPublicLink(result.link, !!siteConfig.is_headless);
    return result;
  } catch (primaryError) {
    const status = primaryError._httpStatus || 0;

    const shouldFallback = primaryIsBridge
      ? canFallbackToRest // Bridge échoue → tenter REST
      : (canFallbackToBridge && ([401, 403, 453].includes(status) || status === 0)); // REST bloqué → tenter Bridge

    if (shouldFallback) {
      const direction = primaryIsBridge ? 'BRIDGE→REST' : 'REST→BRIDGE';
      console.log(`  ⚡ Fallback [${direction}] (HTTP ${status})...`);
      const fallback = await _doPublish(baseUrl, siteConfig, postData, !primaryIsBridge);
      fallback.link = toPublicLink(fallback.link, !!siteConfig.is_headless);
      return fallback;
    }

    // Pas de fallback possible : messages d'erreur enrichis
    if (status === 453) {
      throw new Error(`Le pare-feu BitNinja bloque la requête (Erreur 453). Configurez le Bridge comme filet de sécurité.`);
    }
    if (status === 403 && primaryError.message.includes('Just a moment')) {
      throw new Error(`Cloudflare bloque la requête (Challenge). Configurez le Bridge comme filet de sécurité.`);
    }
    throw primaryError;
  }
}

async function getCategories(siteConfig) {
  const rawUrl = siteConfig.url || siteConfig.wp_url;
  const { wp_user, wp_password, connection_mode, bridge_key } = siteConfig;
  if (!rawUrl) return [];

  const baseUrl = rawUrl.replace(/\/$/, '');
  const isBridge = connection_mode === 'bridge_plugin' && bridge_key;
  const auth = !isBridge ? Buffer.from(`${wp_user}:${wp_password}`).toString('base64') : null;
  
  try {
    const response = await axios.get(`${baseUrl}/wp-json/wp/v2/categories?per_page=100`, {
      timeout: 20000,
      headers: getHeaders(baseUrl, auth, 'application/json', isBridge ? bridge_key : null)
    });
    const decode = s => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#039;/g, "'");
    return response.data.map(cat => ({ id: cat.id, name: decode(cat.name), slug: cat.slug }));
  } catch (error) {
    return [];
  }
}

async function getSiteInventory(siteConfig) {
  const rawUrl = siteConfig.url || siteConfig.wp_url;
  const { wp_user, wp_password, connection_mode, bridge_key } = siteConfig;
  if (!rawUrl) return [];

  const baseUrl = rawUrl.replace(/\/$/, '');
  const isBridge = connection_mode === 'bridge_plugin' && bridge_key;
  const auth = !isBridge ? Buffer.from(`${wp_user}:${wp_password}`).toString('base64') : null;
  
  let allItems = [];
  try {
    const response = await axios.get(`${baseUrl}/wp-json/wp/v2/posts`, {
      params: { per_page: 100, status: 'publish,future,draft,pending', _fields: 'title,slug' },
      timeout: 30000,
      headers: getHeaders(baseUrl, auth, 'application/json', isBridge ? bridge_key : null)
    });
    if (response.data && Array.isArray(response.data)) {
      allItems = response.data;
    }
    return allItems.map(item => ({
      title: item.title.rendered.toLowerCase(),
      slug: item.slug.toLowerCase()
    }));
  } catch (error) {
    return [];
  }
}

async function getSitePostsForCalendar(siteConfig, afterDate) {
  const rawUrl = siteConfig.url || siteConfig.wp_url;
  const { wp_user, wp_password, connection_mode, bridge_key } = siteConfig;
  if (!rawUrl) return [];

  const baseUrl = rawUrl.replace(/\/$/, '');
  const isBridge = connection_mode === 'bridge_plugin' && bridge_key;
  const auth = !isBridge ? Buffer.from(`${wp_user}:${wp_password}`).toString('base64') : null;

  const wpHeaders = getHeaders(baseUrl, auth, 'application/json', isBridge ? bridge_key : null);

  async function fetchByStatus(status) {
    const params = { per_page: 100, status, orderby: 'date', order: 'asc' };
    const response = await axios.get(`${baseUrl}/wp-json/wp/v2/posts`, {
      params,
      timeout: 20000,
      headers: wpHeaders,
    });
    if (!Array.isArray(response.data)) return [];
    const items = [...response.data];
    const totalPages = parseInt(response.headers['x-wp-totalpages'] || '1', 10);
    if (totalPages > 1) {
      const extra = await Promise.all(
        Array.from({ length: totalPages - 1 }, (_, i) =>
          axios.get(`${baseUrl}/wp-json/wp/v2/posts`, {
            params: { ...params, page: i + 2 },
            timeout: 20000,
            headers: wpHeaders,
          }).then(r => Array.isArray(r.data) ? r.data : []).catch(() => [])
        )
      );
      items.push(...extra.flat());
    }
    return items;
  }

  try {
    const [published, scheduled, drafts] = await Promise.all([
      fetchByStatus('publish'),
      fetchByStatus('future'),
      fetchByStatus('draft'),
    ]);
    const posts = [...published, ...scheduled, ...drafts];

    return posts.map(p => ({
        wpPostId: p.id,
        title: p.title?.rendered || '',
        slug: p.slug || '',
        link: p.link || '',
        status: p.status,
        postDate: p.date,
      }));
  } catch (error) {
    throw error;
  }
}

module.exports = { uploadImageToWordPress, publishPost, getCategories, getSiteInventory, getSitePostsForCalendar };
