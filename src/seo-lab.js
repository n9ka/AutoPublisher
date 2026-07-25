// src/seo-lab.js - Discovery Engine
// v2.5.1
require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { getBulkKeywordSuggestions, getKeywordsForSite } = require('./lib/dataforseo');
const { getSiteInventory } = require('./lib/wordpress');
const { decrypt } = require('./lib/encryption');
const { DEEPSEEK_MODEL, generateContent: generateDeepSeek } = require('./lib/deepseek');
const axios = require('axios');
const cheerio = require('cheerio');
const { enrichOpportunitiesWithGsc } = require('./lib/gsc');

const STOP_WORDS = ['et', 'de', 'du', 'le', 'la', 'les', 'des', 'un', 'une', 'pour', 'dans', 'sur', 'd', 'l', 'au', 'aux'];

function semanticNormalize(str) {
  if (!str) return "";
  const normalized = str.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, ' ')
    .trim();
  const words = normalized.split(/\s+/);
  return words
    .filter(w => w.length > 1 && !STOP_WORDS.includes(w))
    .sort()
    .join(' ');
}

async function scrapeHomepageMeta(url) {
  try {
    const response = await axios.get(url, { 
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const $ = cheerio.load(response.data);
    return {
      title: $('title').text() || "",
      description: $('meta[name="description"]').attr('content') || "",
      h1: $('h1').first().text() || ""
    };
  } catch (e) { return null; }
}

async function generateSeeds(site, meta) {
  const persona = site.persona || {};
  const prompt = `Définit les 2 meilleurs mots-clés racines (1 seul mot idéalement, max 2) pour ce site : ${site.name}. Spécialité : ${persona.specialty}. Home : ${meta?.title}. Réponds UNIQUEMENT par la liste, un par ligne. PAS DE GUILLEMETS.`;

  try {
    const response = await generateDeepSeek(prompt, DEEPSEEK_MODEL);
    return response
      .replace(/mots_cles_racines:|mots_cles:|seeds:|axes:|racines:/gi, '')
      .replace(/["'“”«»]/g, '')
      .split('\n')
      .map(s => s.replace(/^\d+[\.\s]*/, '').replace(/[,;.]$/, '').trim())
      .filter(s => s.length > 2 && s.split(' ').length <= 2)
      .slice(0, 2);
  } catch (e) { return []; }
}

async function scoreKeywords(keywords, persona) {
  if (!keywords.length) return {};
  const prompt = `Note la pertinence (0-10) de ces mots-clés pour le persona ${persona.name} (Expert en ${persona.specialty}).\nMOTS-CLÉS :\n${keywords.join('\n')}\nRÉPONDS EN JSON : { \"scores\": [ { \"keyword\": \"...\", \"score\": 8 } ] }`;
  try {
    const response = await generateDeepSeek(prompt, DEEPSEEK_MODEL);
    const jsonMatch = response.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return {};
    const parsed = JSON.parse(jsonMatch[0]);
    const map = {};
    if (parsed.scores) parsed.scores.forEach(s => map[s.keyword.toLowerCase()] = s.score);
    return map;
  } catch (e) { return {}; }
}

async function runDiscovery(siteId) {
  if (!siteId) process.exit(1);
  console.log(`🧪 [Discovery Engine] Lancement de l'analyse...`);

  const { data: site } = await supabase.from('wordpress_sites').select('*').eq('id', siteId).single();
  if (!site) process.exit(1);

  let wpPassword = site.wp_password;
  if (site.wp_password_iv) {
    const [encrypted, authTag] = site.wp_password.split(':');
    wpPassword = decrypt(encrypted, site.wp_password_iv, authTag);
  }

  const meta = await scrapeHomepageMeta(site.url);
  const aiSeeds = await generateSeeds(site, meta);
  
  const domain = new URL(site.url).hostname.replace('www.', '');
  const existingKeywords = await getKeywordsForSite(domain);
  const topExistingSeed = existingKeywords[0]?.keyword_data?.keyword;

  const blacklist = ['actualite', 'actualites', 'news', 'blog', 'info', 'informations'];
  const finalSeeds = [...new Set([topExistingSeed, ...aiSeeds])]
    .filter(Boolean)
    .map(s => s.replace(/["'“”«»]/g, '').toLowerCase().trim())
    .filter(s => s.length > 3 && !blacklist.includes(s))
    .slice(0, 3);

  if (finalSeeds.length === 0) finalSeeds.push(site.persona?.specialty?.split(' ')[0] || "ia");
  console.log(`    🎯 Axes retenus : ${finalSeeds.join(', ')}`);

  const inventory = await getSiteInventory({ ...site, wp_password: wpPassword });
  const forbiddenKeywords = new Set(inventory.map(item => semanticNormalize(item.title)));
  const { data: existingOpps } = await supabase.from('seo_opportunities').select('keyword').eq('wordpress_site_id', siteId);
  (existingOpps || []).forEach(o => forbiddenKeywords.add(semanticNormalize(o.keyword)));
  const { data: backlog } = await supabase.from('seo_backlog').select('keyword').eq('wordpress_site_id', siteId);
  (backlog || []).forEach(b => forbiddenKeywords.add(semanticNormalize(b.keyword)));
  const { data: queue } = await supabase.from('articles_queue').select('source_title').eq('wordpress_site_id', siteId);
  (queue || []).forEach(q => forbiddenKeywords.add(semanticNormalize(q.source_title)));

  console.log(`✅ Inventaire consolidé : ${forbiddenKeywords.size} sujets déjà couverts.`);

  console.log(`📡 Exploration du marché...`);
  const allFoundItems = await getBulkKeywordSuggestions(finalSeeds);

  if (!allFoundItems || allFoundItems.length === 0) {
    await supabase.from('wordpress_sites').update({ is_lab_scanning: false }).eq('id', siteId);
    return;
  }

  const uniqueNewItems = [];
  const seenInThisRun = new Set();
  for (const item of allFoundItems) {
    const kData = item.keyword_data || item;
    const keyword = kData.keyword;
    if (!keyword) continue;
    const semK = semanticNormalize(keyword);
    const kInfo = kData.keyword_info || {};
    if ((kInfo.search_volume || 0) < 10) continue;
    if (forbiddenKeywords.has(semK) || seenInThisRun.has(semK)) continue;
    uniqueNewItems.push(item);
    seenInThisRun.add(semK);
  }

  if (uniqueNewItems.length === 0) {
    await supabase.from('wordpress_sites').update({ is_lab_scanning: false }).eq('id', siteId);
    return;
  }

  console.log(`✅ ${uniqueNewItems.length} nouvelles pépites. Scoring lot...`);
  const BATCH_SIZE = 100;
  const opportunities = [];
  for (let i = 0; i < uniqueNewItems.length; i += BATCH_SIZE) {
    const batch = uniqueNewItems.slice(i, i + BATCH_SIZE);
    const scores = await scoreKeywords(batch.map(it => (it.keyword_data || it).keyword), site.persona || {});
    for (const item of batch) {
      const kData = item.keyword_data || item;
      opportunities.push({
        user_id: site.user_id,
        wordpress_site_id: site.id,
        keyword: kData.keyword,
        search_volume: kData.keyword_info?.search_volume || 0,
        keyword_difficulty: kData.keyword_properties?.keyword_difficulty || 0,
        cpc: kData.keyword_info?.cpc || 0,
        relevance_score: scores[kData.keyword.toLowerCase()] || 0,
        source: 'engine_discovery_v2.5',
        status: 'new',
        created_at: new Date().toISOString()
      });
    }
  }

  // Enrichissement GSC — skip silencieux si aucun mapping configuré pour ce site
  await enrichOpportunitiesWithGsc(opportunities, siteId, supabase);

  await supabase.from('seo_opportunities').insert(opportunities);
  await supabase.from('wordpress_sites').update({ is_lab_scanning: false }).eq('id', siteId);
  console.log(`🚀 Discovery complete.`);
  process.exit(0);
}

runDiscovery(process.argv[2]).catch(async err => {
  await supabase.from('wordpress_sites').update({ is_lab_scanning: false }).eq('id', process.argv[2]);
  process.exit(1);
});
