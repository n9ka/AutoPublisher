// Standards de Prompts Image
// Permet une identité visuelle cohérente et une maintenance facile.

/**
 * NOUVEAU STANDARD (2026) - Optimisé pour FLUX (Textless / Minimaliste)
 * Focus sur la photographie pure pour éviter les hallucinations de texte.
 */
const FEATURED_IMAGE_PROMPT_V2 = "An ultra-detailed English prompt for a high-quality, textless professional photography. Focus on a single centered main object related to the topic. Use a minimalist composition, natural lighting, macro or sharp focus, and bokeh background. STRICTLY NO text, NO letters, NO words, NO labels, NO overlays.";

/**
 * ANCIEN STANDARD (BACKUP) - Plus descriptif
 * Utilisé historiquement pour RSS et Trends.
 */
const FEATURED_IMAGE_PROMPT_V1 = "A single, clear, high-quality, photorealistic scene focused on ONE main subject related to the article topic. Minimalist composition, professional lighting, depth of field. NO text, NO letters, NO words, NO labels, NO multiple windows, NO clutter, NO overlays.";

module.exports = {
  FEATURED_IMAGE_PROMPT_V2,
  FEATURED_IMAGE_PROMPT_V1
};
