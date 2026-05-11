const BASE_URL = 'https://rapid-indexer.com/api/v1/index.php';

async function submitUrl(url, title) {
  const apiKey = process.env.RAPID_INDEXER_API_KEY;
  if (!apiKey) throw new Error('[Indexer] Clé API non configurée (RAPID_INDEXER_API_KEY)');

  const response = await fetch(`${BASE_URL}?action=create_task`, {
    method: 'POST',
    headers: {
      'X-API-Key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      urls: [url],
      type: 'indexer',
      engine: 'google',
      title: title || 'Aspy',
    }),
  });

  const data = await response.json();
  if (!data.success) throw new Error(`[Indexer] Échec soumission: ${JSON.stringify(data)}`);
  return data.task_id;
}

module.exports = { submitUrl };
