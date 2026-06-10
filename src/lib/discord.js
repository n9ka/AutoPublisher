async function sendDiscordWebhook(content) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl || !content) return;

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });

    if (!response.ok) {
      console.warn(`⚠️ Discord webhook failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('⚠️ Discord webhook failed:', error.message);
  }
}

module.exports = { sendDiscordWebhook };
