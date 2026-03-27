const axios = require('axios');

if (!process.env.PEXELS_API_KEY) {
  console.warn('PEXELS_API_KEY is missing.');
}

/**
 * Cherche une image sur Pexels via un mot-clé
 */
async function searchImage(query) {
  try {
    const response = await axios.get(`https://api.pexels.com/v1/search`, {
      headers: { Authorization: process.env.PEXELS_API_KEY },
      params: {
        query: query,
        per_page: 1,
        orientation: 'landscape', // Format article classique
        locale: 'fr-FR' // Essayer de matcher des résultats pertinents localement si possible
      }
    });

    if (response.data.photos && response.data.photos.length > 0) {
      const photo = response.data.photos[0];
      return {
        url: photo.src.large2x, // Haute qualité
        alt: photo.alt || query,
        photographer: photo.photographer,
        original_link: photo.url
      };
    }
    return null;
  } catch (error) {
    console.error('Error searching Pexels:', error.message);
    return null;
  }
}

module.exports = { searchImage };
