const OpenAI = require('openai');

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
 * Génère un contenu via DeepSeek (V3 ou R1) avec retry manuel pour instabilité serveur
 */
async function generateContent(prompt, model = 'deepseek-chat', retries = 3) {
  const isReasoner = model === 'deepseek-reasoner';
  
  const params = {
    model: model,
    messages: [
      { role: 'system', content: 'You are an expert WordPress content writer and developer. You output strict JSON.' },
      { role: 'user', content: prompt }
    ],
    max_tokens: isReasoner ? 60000 : 8192,
  };

  if (!isReasoner) {
    params.temperature = 1.1;
  }

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
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
        console.warn(`  ⚠️ DeepSeek (${model}) : ${error.message}. Tentative ${attempt}/${retries} dans ${delay/1000}s...`);
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

module.exports = { deepseek, generateContent };
