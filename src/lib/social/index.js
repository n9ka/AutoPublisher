const { supabase } = require('../supabase');

const ADAPTERS = {
  buffer: require('./buffer'),
};

/**
 * Vérifie si le provider peut poster (quota)
 */
function canPost(accountConfig) {
  const adapter = ADAPTERS[accountConfig.provider];
  if (!adapter) throw new Error(`Provider inconnu : ${accountConfig.provider}`);
  return adapter.canPost(accountConfig.quota_usage, accountConfig.quota_limits);
}

/**
 * Poste sur les réseaux sociaux via le bon adapter
 * @param {object} siteConfig  - ligne site_social_config
 * @param {object} accountConfig - ligne user_social_accounts
 * @param {string} text
 * @returns {Array} résultats par channel
 */
async function postToSocial(siteConfig, accountConfig, text) {
  const adapter = ADAPTERS[accountConfig.provider];
  if (!adapter) throw new Error(`Provider inconnu : ${accountConfig.provider}`);

  if (!canPost(accountConfig)) {
    throw new Error(`Quota journalier atteint pour ${accountConfig.provider}`);
  }

  const results = await adapter.post(siteConfig, accountConfig, text);
  await updateQuotaUsage(accountConfig.id);
  return results;
}

/**
 * Incrémente le compteur de posts du jour
 */
async function updateQuotaUsage(accountId) {
  const { data: account } = await supabase
    .from('user_social_accounts')
    .select('quota_usage')
    .eq('id', accountId)
    .single();

  const today = new Date().toISOString().slice(0, 10);
  const usage = account?.quota_usage ?? {};

  const updatedUsage = {
    today_count: usage.reset_date === today ? (usage.today_count ?? 0) + 1 : 1,
    reset_date: today,
    last_posted_at: new Date().toISOString(),
  };

  await supabase
    .from('user_social_accounts')
    .update({ quota_usage: updatedUsage })
    .eq('id', accountId);
}

/**
 * Liste les channels disponibles pour un compte (pour l'UI)
 */
async function getChannels(provider, apiKey) {
  const adapter = ADAPTERS[provider];
  if (!adapter) throw new Error(`Provider inconnu : ${provider}`);
  return adapter.getChannels(apiKey);
}

module.exports = { postToSocial, canPost, getChannels, updateQuotaUsage };
