const axios = require('axios');

/**
 * Génère des headers "humains" ultra-récents pour contourner les WAF (BitNinja 453, Imunify, Cloudflare, etc.)
 */
function getHeaders(baseUrl, auth = null, contentType = 'application/json', bridgeKey = null) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
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

/**
 * Télécharge une image depuis une URL et l'upload sur WordPress
 */
async function uploadImageToWordPress(wpUrl, wpUser, wpPassword, imageUrl, altText, connectionMode = 'rest_api', bridgeKey = null) {
  if (!wpUrl || !imageUrl) return null;
  const baseUrl = wpUrl.replace(/\/$/, '');

  // Mode Bridge : laisser le plugin gérer l'image côté WordPress
  if (connectionMode === 'bridge_plugin' || connectionMode === 'bridge_deferred') {
    console.log('  🛡️  Image : Mode Bridge, transfert différé au plugin...');
    return { id: null, url: imageUrl, is_bridge: true };
  }

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

    return { id: mediaId, url: localUrl };

  } catch (error) {
    const status = error.response ? error.response.status : 0;
    console.error(`Erreur upload image WP: HTTP ${status}`);
    // Sur erreur d'auth/WAF, retourner bridge_deferred si le Bridge est configuré
    // → publishPost pourra utiliser l'URL externe lors du fallback Bridge
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
    if (postData.featured_media_url) payload.featured_image_url = postData.featured_media_url;
    if (postData.infographic_url) {
      payload.infographic_image_url = postData.infographic_url;
      payload.infographic_alt_text = postData.infographic_alt || 'Infographie';
    }
  } else {
    payload.title = postData.title;
    payload.content = postData.content;
  }

  try {
    const response = await axios.post(targetUrl, payload, {
      timeout: 60000,
      headers: getHeaders(baseUrl, auth, 'application/json', useBridge ? bridge_key : null)
    });

    const data = response.data;
    const publishedLink = (data && typeof data === 'object' && data.link && typeof data.link === 'string')
      ? data.link
      : `${baseUrl}/?p=${data && data.id ? data.id : 'unknown'}`;

    return { success: true, id: data?.id || null, link: publishedLink };

  } catch (error) {
    const errorData = error.response ? error.response.data : error.message;
    const status = error.response ? error.response.status : 0;
    console.error(`Erreur publication WP (${useBridge ? 'BRIDGE' : 'REST'}):`, status);

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
    return await _doPublish(baseUrl, siteConfig, postData, primaryIsBridge);
  } catch (primaryError) {
    const status = primaryError._httpStatus || 0;

    const shouldFallback = primaryIsBridge
      ? canFallbackToRest // Bridge échoue → tenter REST
      : (canFallbackToBridge && [401, 403, 453].includes(status)); // REST bloqué → tenter Bridge

    if (shouldFallback) {
      const direction = primaryIsBridge ? 'BRIDGE→REST' : 'REST→BRIDGE';
      console.log(`  ⚡ Fallback [${direction}] (HTTP ${status})...`);
      return await _doPublish(baseUrl, siteConfig, postData, !primaryIsBridge);
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
    return response.data.map(cat => ({ id: cat.id, name: cat.name, slug: cat.slug }));
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
    const [published, scheduled] = await Promise.all([
      fetchByStatus('publish'),
      fetchByStatus('future'),
    ]);
    const posts = [...published, ...scheduled];

    return posts
      .filter(p => !afterDate || p.date >= afterDate)
      .map(p => ({
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
