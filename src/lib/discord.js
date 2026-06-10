function getDiscordWebhookTimeoutMs() {
  const parsed = Number.parseInt(process.env.DISCORD_WEBHOOK_TIMEOUT_MS || '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 5000;
}

async function sendDiscordWebhook(content) {
  const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
  if (!webhookUrl || !content) return;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), getDiscordWebhookTimeoutMs());

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
      signal: controller.signal,
    });

    if (!response.ok) {
      console.warn(`⚠️ Discord webhook failed: HTTP ${response.status}`);
    }
  } catch (error) {
    console.warn('⚠️ Discord webhook failed:', error.message);
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { sendDiscordWebhook };
