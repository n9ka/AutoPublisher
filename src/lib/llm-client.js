/**
 * llm-client.js — Client HTTP générique OpenAI-compatible
 * Supporte tout provider avec une API /v1/chat/completions (OpenRouter, MiniMax, Anthropic, DeepSeek, Gemini...)
 * La configuration (url, clé env, modèle) vient d'une ligne de la table llm_models en DB.
 */

/**
 * @param {string} prompt
 * @param {Object} modelConfig — ligne complète de llm_models, chargée depuis Supabase
 * @param {string} modelConfig.api_base_url
 * @param {string} modelConfig.api_key_env
 * @param {string} modelConfig.model_id
 * @param {number|null} modelConfig.max_output_tokens
 * @param {string[]|null} modelConfig.provider_order — ordre de préférence des providers OpenRouter (ex: ["io.net"])
 * @returns {Promise<string>} — contenu texte de la réponse
 */
async function generateWithLLM(prompt, modelConfig) {
  const apiKey = process.env[modelConfig.api_key_env];
  if (!apiKey) {
    throw new Error(`Clé API manquante : ${modelConfig.api_key_env} n'est pas définie dans l'environnement`);
  }

  const body = {
    model: modelConfig.model_id,
    messages: [{ role: 'user', content: prompt }],
  };

  if (modelConfig.max_output_tokens) {
    body.max_tokens = modelConfig.max_output_tokens;
  }

  if (modelConfig.provider_order && Array.isArray(modelConfig.provider_order) && modelConfig.provider_order.length > 0) {
    body.provider = { order: modelConfig.provider_order };
  }

  const res = await fetch(`${modelConfig.api_base_url}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`LLM error ${res.status} (${modelConfig.label || modelConfig.model_id}): ${errorText}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;

  if (!content) {
    throw new Error(`Réponse LLM vide ou malformée (${modelConfig.label || modelConfig.model_id})`);
  }

  return content;
}

module.exports = { generateWithLLM };
