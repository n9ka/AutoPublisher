const { Runware } = require('@runware/sdk-js');

/**
 * Génère une image via Runware avec retry auto et fallback de modèle
 * @param {string} prompt 
 * @param {string} type "photo" ou "infographic"
 * @param {number} retries 
 * @param {string} modelId Optionnel : Forcer un modèle spécifique
 */
async function generateRunwareImage(prompt, type = "photo", retries = 3, modelId = null) {
  const apiKey = process.env.RUNWARE_API_KEY;

  if (!apiKey) {
    console.error('    ❌ [Runware] Erreur: RUNWARE_API_KEY est indéfinie dans l\'environnement.');
    return null;
  }

  let finalPrompt = prompt;
  let model = modelId || 'runware:400@2'; // Flux Schnell par défaut
  let width = 1216;
  let height = 640;
  let extraParams = {};

  if (type === "infographic") {
    // Stratégie Infographie : Nano Banana 2 par défaut, fallback sur Flux Dev
    model = modelId || 'google:4@3';
    
    // NOUVEAU : Nano Banana 2 ne supporte pas le 768x768. 
    // On force le 1024x1024 pour Banana, on garde 768 pour les autres.
    if (model.includes('google')) {
      width = 1024;
      height = 1024;
    } else {
      width = 768;
      height = 768;
    }
    
    console.log(`    📊 Mode Infographie activé (Tentative Model: ${model} en ${width}x${height})`);
  } else {
    finalPrompt = `${prompt}, photorealistic, 4k, sharp focus`;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      // Configuration des paramètres spécifiques selon le modèle choisi
      let currentParams = { ...extraParams };
      if (model.includes('400@1')) {
        currentParams.CFGScale = 3.5;
        currentParams.scheduler = 'FlowMatchEulerDiscreteScheduler';
      }

      const runware = new Runware({ apiKey });
      const images = await runware.requestImages({
        positivePrompt: finalPrompt,
        model: model, 
        width: width,
        height: height,
        numberResults: 1,
        outputFormat: 'JPG',
        ...currentParams
      });

      if (images && images.length > 0) {
        return images[0].imageURL;
      }
      
      console.warn(`    ⚠️ [Runware] Tentative ${attempt}/${retries}: Aucune image retournée.`);

    } catch (error) {
      console.error(`    ❌ [Runware Error] Tentative ${attempt}/${retries} avec ${model}:`, error.message || error);
      
      // FALLBACK SPÉCIFIQUE : Si Nano Banana 2 échoue, on bascule sur Flux Dev pour la prochaine tentative
      if (type === "infographic" && model === 'google:4@3' && attempt < retries) {
        console.log('    🔄 Fallback sur Flux Dev (runware:400@1)...');
        model = 'runware:400@1';
        continue; // On retente immédiatement
      }

      if (attempt === retries) {
        return null;
      }
    }

    if (attempt < retries) {
      const delay = 2000 * attempt; 
      console.log(`    ⏳ [Runware] Nouvelle tentative dans ${delay/1000}s...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  return null;
}

module.exports = { generateRunwareImage };
