let peakRequestAt = null;

function isDeepSeekPeakUtc(date = new Date()) {
  const minutes = date.getUTCHours() * 60 + date.getUTCMinutes();
  return (minutes >= 60 && minutes < 240) || (minutes >= 360 && minutes < 600);
}

function isDirectDeepSeekApi(apiBaseUrl) {
  try {
    return new URL(apiBaseUrl).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function recordDeepSeekRequest(apiBaseUrl, date = new Date()) {
  if (!peakRequestAt && isDirectDeepSeekApi(apiBaseUrl) && isDeepSeekPeakUtc(date)) {
    peakRequestAt = date;
  }
}

function getDeepSeekPeakTelegramNote() {
  if (!peakRequestAt) return '';

  const time = peakRequestAt.toISOString().slice(11, 16);
  return `\n⚠️ <b>DeepSeek peak</b> : appel API à ${time} UTC`;
}

module.exports = { recordDeepSeekRequest, getDeepSeekPeakTelegramNote, isDeepSeekPeakUtc };
