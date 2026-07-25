const OpenAI = require('openai');
const { recordDeepSeekRequest } = require('./deepseek-pricing');

const DEEPSEEK_MODEL = 'deepseek-v4-flash';

if (!process.env.DEEPSEEK_API_KEY) {
  console.warn('DEEPSEEK_API_KEY is missing.');
}

const deepseek = new OpenAI({
  apiKey: process.env.DEEPSEEK_API_KEY,
  baseURL: 'https://api.deepseek.com',
  timeout: 600000, // Augmenté à 10 minutes pour les articles Expert (Reasoner a besoin de temps)
  maxRetries: 3    // Auto-retry intégré en cas de timeout réseau
});

/**
 * Génère un contenu via DeepSeek V4 Flash avec retry manuel pour instabilité serveur.
 * Les anciens alias sont normalisés pour ne jamais être envoyés à l'API.
 */
async function generateContent(prompt, model = DEEPSEEK_MODEL, retries = 3, options = {}) {
  const legacyThinking = model === 'deepseek-reasoner';
  const normalizedModel = model === 'deepseek-chat' || legacyThinking ? DEEPSEEK_MODEL : model;
  const thinkingEnabled = options.thinking === true || legacyThinking;
  
  const params = {
    model: normalizedModel,
    messages: [
      { role: 'system', content: 'You are an expert WordPress content writer and developer. You output strict JSON.' },
      { role: 'user', content: prompt }
    ],
    thinking: { type: thinkingEnabled ? 'enabled' : 'disabled' },
    max_tokens: thinkingEnabled ? 60000 : 8192,
  };

  if (thinkingEnabled) {
    params.reasoning_effort = options.reasoningEffort || 'high';
  } else {
    params.temperature = 1.1;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    // Cache-busting : DeepSeek met en cache les requêtes identiques, le retry rejouerait la même erreur
    if (attempt > 1) {
      params.messages = [...params.messages];
      params.messages[0] = { ...params.messages[0], content: params.messages[0].content.replace(/ \[retry-\d+\]$/, '') + ` [retry-${Date.now()}]` };
    }
    try {
      recordDeepSeekRequest('https://api.deepseek.com');
      const response = await deepseek.chat.completions.create(params);
      return response.choices[0].message.content;
    } catch (error) {
      const isRetryable = error.message.includes('terminated') || 
                          error.message.includes('timeout') || 
                          error.name === 'AbortError' || 
                          error.status === 503 || 
                          error.status === 429;

      if (isRetryable && attempt < retries) {
        const delay = 5000 * attempt;
        console.warn(`  ⚠️ DeepSeek (${normalizedModel}) : ${error.message}. Tentative ${attempt}/${retries} dans ${delay/1000}s...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }

      // Si pas retryable ou épuisé
      if (error.name === 'AbortError' || error.message.includes('canceled') || error.message.includes('timeout')) {
        console.error('❌ DeepSeek: Requête annulée ou Timeout (Délai dépassé).');
      } else if (error.message.includes('terminated')) {
        console.error('❌ DeepSeek: Connexion interrompue par le serveur (Terminated).');
      } else {
        console.error('❌ Error calling DeepSeek API:', error.message);
      }
      throw error;
    }
  }
}

module.exports = { DEEPSEEK_MODEL, deepseek, generateContent };
