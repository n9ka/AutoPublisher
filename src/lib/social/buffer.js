const { decrypt } = require('../encryption');

const BUFFER_API = 'https://api.buffer.com/graphql';

const DEFAULT_LIMITS = {
  daily_posts_per_channel: 10,
  api_rpm: 60,
};

const CREATE_POST_MUTATION = `
  mutation CreatePost($input: CreatePostInput!) {
    createPost(input: $input) {
      ... on PostActionSuccess {
        post { id status }
      }
      ... on InvalidInputError  { message }
      ... on LimitReachedError  { message }
      ... on UnauthorizedError  { message }
      ... on UnexpectedError    { message }
    }
  }
`;

const GET_CHANNELS_QUERY = `
  query GetChannels($orgId: String!) {
    channels(input: { organizationId: $orgId }) {
      id
      name
      service
    }
  }
`;

const GET_ORG_QUERY = `
  query {
    organization { id name }
  }
`;

/**
 * Vérifie si le quota permet de poster
 */
function canPost(quotaUsage = {}, quotaLimits = {}) {
  const limits = { ...DEFAULT_LIMITS, ...quotaLimits };
  const today = new Date().toISOString().slice(0, 10);

  if (quotaUsage.reset_date !== today) return true;
  return (quotaUsage.today_count ?? 0) < limits.daily_posts_per_channel;
}

/**
 * Appel GraphQL générique
 */
async function gql(token, query, variables = {}) {
  const response = await fetch(BUFFER_API, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!response.ok) {
    throw new Error(`Buffer HTTP ${response.status}: ${await response.text()}`);
  }

  const json = await response.json();

  if (json.errors?.length) {
    throw new Error(`Buffer GraphQL: ${json.errors.map(e => e.message).join(', ')}`);
  }

  return json.data;
}

/**
 * Liste les channels d'un compte Buffer (pour l'UI)
 * @param {string} apiKey - clé API en clair
 * @returns {Array<{id, name, service}>}
 */
async function getChannels(apiKey) {
  // Récupère d'abord l'orgId depuis le token
  const orgData = await gql(apiKey, GET_ORG_QUERY);
  const orgId = orgData?.organization?.id;

  if (!orgId) throw new Error('Organisation Buffer introuvable');

  const data = await gql(apiKey, GET_CHANNELS_QUERY, { orgId });
  return data?.channels ?? [];
}

/**
 * Poste sur tous les channel_ids configurés pour un site
 * @param {object} siteConfig - ligne site_social_config
 * @param {object} accountConfig - ligne user_social_accounts
 * @param {string} text - texte du post
 * @returns {Array<{channelId, postId, status}>}
 */
async function post(siteConfig, accountConfig, text) {
  const [encryptedContent, authTag] = accountConfig.api_key.split(':');
  const token = decrypt(encryptedContent, accountConfig.api_key_iv, authTag);

  const channelIds = siteConfig.channel_ids ?? [];
  if (channelIds.length === 0) throw new Error('Aucun channel configuré pour ce site');

  const results = [];

  for (const channelId of channelIds) {
    const data = await gql(token, CREATE_POST_MUTATION, {
      input: {
        channelId,
        text,
        schedulingType: 'automatic',
        mode: 'shareNow',
      },
    });

    const result = data?.createPost;

    if (result?.message) {
      throw new Error(`Buffer: ${result.message}`);
    }

    results.push({
      channelId,
      postId: result?.post?.id,
      status: result?.post?.status,
    });
  }

  return results;
}

module.exports = { post, getChannels, canPost, DEFAULT_LIMITS };
