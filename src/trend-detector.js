require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { getDailyTrends } = require('./lib/trends');
const { researchTrendTopic } = require('./lib/research');
const { getFreudixTrendMetrics } = require('./lib/freudix');
const { getEmbedding, filterBestArticlesBatch } = require('./lib/gemini');
const { sendTelegram } = require('./lib/telegram');
const { getAutomatedOffPeakBlockReason, formatUtcTime } = require('./lib/deepseek-pricing');
const TREND_SEMANTIC_MATCH_THRESHOLD = parseFloat(process.env.TREND_SEMANTIC_MATCH_THRESHOLD || '0.75');
const TREND_DUPLICATE_LOOKBACK_DAYS = parseInt(process.env.TREND_DUPLICATE_LOOKBACK_DAYS || '45', 10);

function normalizeText(text = "") {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function parseKeywords(rawKeywords = "") {
  return rawKeywords
    .split(/[,\n;|]/)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);
}

function scoreTrendByKeywords(trend, keywordList) {
  if (!keywordList.length) return 0;
  const title = normalizeText(trend.title || "");
  const snippet = normalizeText((trend.articles || []).map((a) => a.snippet || "").join(' ').slice(0, 300));
  let score = 0;

  for (const keyword of keywordList) {
    const k = normalizeText(keyword);
    if (!k) continue;

    if (title.includes(k)) score += 3;
    if (snippet.includes(k)) score += 1;
  }

  return score;
}

function compareTrendCandidates(a, b) {
  if (b.score !== a.score) return b.score - a.score;

  const trafficDifference = (b.trend.trendsTraffic || 0) - (a.trend.trendsTraffic || 0);
  if (trafficDifference !== 0) return trafficDifference;

  const volumeDifference = (b.trend.searchVolume || 0) - (a.trend.searchVolume || 0);
  if (volumeDifference !== 0) return volumeDifference;

  return (a.trend.title || '').localeCompare(b.trend.title || '', 'fr');
}

function isTrendExcluded(trend, keywordList) {
  if (!keywordList.length) return false;

  const title = normalizeText(trend.title || "");
  const snippet = normalizeText((trend.articles || []).map((a) => a.snippet || "").join(' ').slice(0, 300));

  return keywordList.some((keyword) => {
    const normalizedKeyword = normalizeText(keyword);
    return normalizedKeyword && (title.includes(normalizedKeyword) || snippet.includes(normalizedKeyword));
  });
}

function buildTrendResearchQuery(title, rawKeywords, category) {
  const keywordList = parseKeywords(rawKeywords).slice(0, 2);
  const categoryHintMap = {
    'affaires-finance': 'affaires finance',
    'alimentation-boissons': 'alimentation boissons',
    'auto-vehicules': 'automobile vehicules',
    autre: 'actualite',
    'beaute-mode': 'beaute mode',
    'climat-meteo': 'climat meteo',
    divertissement: 'divertissement',
    'emploi-education': 'emploi education',
    jeux: 'jeux',
    'loi-gouvernement': 'loi gouvernement',
    'loisirs-passe-temps': 'loisirs passe temps',
    politique: 'politique',
    sante: 'sante',
    sciences: 'sciences',
    shopping: 'shopping',
    sports: 'sports',
    technologie: 'technologie',
    'voyage-transport': 'voyage transport'
  };

  const parts = [title];
  if (keywordList.length) parts.push(keywordList.join(' '));
  if (categoryHintMap[category]) parts.push(categoryHintMap[category]);
  return parts.join(' ');
}

function normalizeTitleForDup(text = "") {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+-\s+[^|]{2,80}$/u, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenSet(text = "") {
  return new Set(
    normalizeTitleForDup(text)
      .split(' ')
      .filter((t) => t.length >= 3)
  );
}

function titleSimilarityScore(a = "", b = "") {
  const ta = tokenSet(a);
  const tb = tokenSet(b);
  if (!ta.size || !tb.size) return 0;

  let overlap = 0;
  for (const token of ta) {
    if (tb.has(token)) overlap++;
  }
  return overlap / Math.max(ta.size, tb.size);
}

function isLikelySameTopic(a = "", b = "") {
  const na = normalizeTitleForDup(a);
  const nb = normalizeTitleForDup(b);
  if (!na || !nb) return false;
  if (na === nb) return true;

  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length > nb.length ? na : nb;
  if (shorter.length >= 22 && longer.includes(shorter)) return true;

  return titleSimilarityScore(na, nb) >= 0.72;
}

function buildTrendEmbeddingText(trend) {
  const title = normalizeTitleForDup(trend.title || "");
  const snippet = (trend.articles || [])
    .map((a) => a.snippet || "")
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 700);
  return `${title} ${snippet}`.trim();
}

function buildTrendSourceContext(trend, freudixMetrics, research, category) {
  const metrics = freudixMetrics || {};
  const lines = [
    '# DONNÉES SEO FREUDIX',
    `Sujet : ${trend.title}`,
    `Catégorie : ${category || trend.category || 'non précisée'}`,
    `Trafic Google Trends estimé : ${metrics.trendsTraffic || trend.trendsTraffic || 0}`,
    `Volume de recherche mensuel : ${metrics.searchVolume || trend.searchVolume || 0}`,
  ];

  if (metrics.cpc !== null && metrics.cpc !== undefined) lines.push(`CPC estimé : ${metrics.cpc}`);
  if (metrics.competition !== null && metrics.competition !== undefined) lines.push(`Concurrence SEO : ${metrics.competition}`);
  if (metrics.updatedAt) lines.push(`Données Freudix mises à jour : ${metrics.updatedAt}`);
  if (metrics.analyzeUrl) lines.push(`Analyse Freudix : ${metrics.analyzeUrl}`);

  lines.push('', '# QUALITÉ DE LA RECHERCHE');
  lines.push(`Provider principal : ${research.meta.provider}`);
  lines.push(`Sources exploitables : ${research.meta.source_count} — domaines distincts : ${research.meta.distinct_domain_count}`);
  lines.push(`Tavily utilisé : ${research.meta.used_tavily ? 'oui' : 'non'}`);
  lines.push(`Évaluation : ${research.meta.quality_reason}`);
  lines.push('', research.context || 'Aucune source exploitable : rester factuel et limiter les affirmations.');

  return lines.join('\n').slice(0, 48000);
}

async function detectTrends() {
  const now = new Date();
  const blockReason = getAutomatedOffPeakBlockReason(now);
  if (blockReason) {
    const time = formatUtcTime(now);
    const message = `⏸️ <b>Trend Spy reporté</b> à ${time} UTC : ${blockReason}. Aucune recherche de tendance ni aucun job Trend n'a été créé.`;
    console.log(message);
    await sendTelegram(message);
    return;
  }

  console.log('🔍 Démarrage de Trend Spy (Recherche de tendances)...');

  const { data: spies, error: spyError } = await supabase
    .from('trend_spies')
    .select('*, wordpress_sites(*)')
    .eq('active', true);

  if (spyError) return console.error(spyError);

  for (const spy of spies) {
    const site = spy.wordpress_sites;
    console.log(`\n--- Espion pour : ${site.name} (Catégorie: ${spy.category}) ---`);

    // 1. Quota hebdomadaire lissé, identique au métronome RSS.
    const maxPerWeek = spy.max_trends_per_week ?? 7;

    if (maxPerWeek <= 0) {
      console.log('🛑 Quota Trend Spy désactivé. Skip.');
      continue;
    }

    const intervalHours = (7 * 24) / maxPerWeek;

    if (spy.last_trend_detection_at) {
      const lastDetection = new Date(spy.last_trend_detection_at);
      const diffHours = (new Date() - lastDetection) / (60 * 60 * 1000);

      if (diffHours < intervalHours) {
        console.log(`⏳ Trop tôt pour Trend Spy (dernier ajout il y a ${diffHours.toFixed(1)}h, intervalle cible : ${intervalHours.toFixed(1)}h). Skip.`);
        continue;
      }
    }

    // 2. Fetch Trends
    const trends = await getDailyTrends(spy.category);
    if (trends.length === 0) {
      console.log('Ø Aucune tendance trouvée.');
      continue;
    }

    // 3. Préparation des tendances avec préférence keywords (souple)
    const keywords = spy.keywords || "";
    const parsedKeywords = parseKeywords(keywords);
    const excludedKeywords = parseKeywords(spy.excluded_keywords || "");
    const requireKeywordMatch = spy.require_keyword_match === true;
    const eligibleTrends = trends.filter((trend) => !isTrendExcluded(trend, excludedKeywords));

    if (eligibleTrends.length === 0) {
      console.log('Ø Toutes les tendances sont exclues par les mots-clés configurés.');
      continue;
    }

    const maxPoolSize = Math.min(eligibleTrends.length, 20);
    const exploratorySlots = parsedKeywords.length
      ? Math.min(2, Math.max(1, Math.floor(maxPoolSize * 0.25)))
      : 0;

    const scoredTrends = eligibleTrends
      .map((trend) => ({ trend, score: scoreTrendByKeywords(trend, parsedKeywords) }))
      .sort(compareTrendCandidates);

    const keywordHits = scoredTrends.filter((item) => item.score > 0);
    let candidateTrends = [];
    if (requireKeywordMatch) {
      candidateTrends = keywordHits.slice(0, maxPoolSize).map((item) => item.trend);
    } else if (parsedKeywords.length > 0) {
      const noHit = scoredTrends.filter((item) => item.score === 0);
      const focusSize = Math.max(1, maxPoolSize - exploratorySlots);

      candidateTrends = [
        ...keywordHits.slice(0, focusSize),
        ...noHit.slice(0, exploratorySlots)
      ].map((item) => item.trend);

      if (candidateTrends.length < maxPoolSize) {
        const alreadyAdded = new Set(candidateTrends.map((t) => t.title));
        const remaining = scoredTrends
          .map((item) => item.trend)
          .filter((trend) => !alreadyAdded.has(trend.title))
          .slice(0, maxPoolSize - candidateTrends.length);
        candidateTrends = [...candidateTrends, ...remaining];
      }
    } else {
      candidateTrends = scoredTrends.map((item) => item.trend).slice(0, maxPoolSize);
    }

    if (candidateTrends.length === 0) {
      console.log(requireKeywordMatch
        ? 'Ø Aucune tendance ne correspond aux mots-clés requis.'
        : 'Ø Aucune tendance trouvée.');
      continue;
    }

    console.log(
      `🧭 Préfiltre keywords: ${parsedKeywords.length ? parsedKeywords.join(', ') : 'aucun'} | mode strict: ${requireKeywordMatch ? 'oui' : 'non'} | exclusions: ${excludedKeywords.length ? excludedKeywords.join(', ') : 'aucune'} | priorité : mots-clés > trafic Trends > volume SEO | ${candidateTrends.length}/${eligibleTrends.length} tendances conservées.`
    );
    console.log(`🧐 Analyse IA de ${candidateTrends.length} tendances candidates...`);

    // 4. Filtrage IA (Gemma) avec préférences de mots-clés
    const formattedCandidates = candidateTrends.map(t => ({
      title: t.title,
      contentSnippet: t.articles.map(a => a.snippet).join(' ').substring(0, 200)
    }));

    const selectedIndices = await filterBestArticlesBatch(formattedCandidates, site.persona, keywords);
    console.log(`✅ L'IA a retenu ${selectedIndices.length} tendances pertinentes.`);

    const lookback = new Date();
    lookback.setDate(lookback.getDate() - TREND_DUPLICATE_LOOKBACK_DAYS);
    const lookbackIso = lookback.toISOString();

    const [{ data: recentProcessed }, { data: recentQueue }] = await Promise.all([
      supabase
        .from('processed_articles')
        .select('source_title')
        .eq('wordpress_site_id', site.id)
        .gte('processed_at', lookbackIso),
      supabase
        .from('articles_queue')
        .select('source_title')
        .eq('wordpress_site_id', site.id)
        .eq('source_type', 'trend')
        .gte('created_at', lookbackIso)
    ]);

    const recentTrendTitles = [
      ...(recentProcessed || []).map((row) => row.source_title),
      ...(recentQueue || []).map((row) => row.source_title)
    ].filter(Boolean);
    const titlesAddedThisRun = [];

    // 5. Recherche & Insertion
    let added = 0;

    for (const idx of selectedIndices) {
      if (added >= 1) break;

      const trend = candidateTrends[idx];

      if (
        recentTrendTitles.some((title) => isLikelySameTopic(trend.title, title)) ||
        titlesAddedThisRun.some((title) => isLikelySameTopic(trend.title, title))
      ) {
        console.log(`    Ø Sujet déjà couvert récemment (titre proche) : "${trend.title}"`);
        continue;
      }
      
      // 1. Anti-doublon Exact (File d'attente)
      const { data: inQueue } = await supabase
        .from('articles_queue')
        .select('id')
        .eq('wordpress_site_id', site.id)
        .eq('source_title', trend.title)
        .single();

      if (inQueue) {
        console.log(`    Ø Déjà en file d'attente : ${trend.title}`);
        continue;
      }

      // 2. Anti-doublon Sémantique (Vecteurs)
      const embeddingText = buildTrendEmbeddingText(trend);
      const embedding = await getEmbedding(embeddingText);

      if (!embedding) {
        console.log(`    Ø Embedding indisponible, insertion bloquée pour éviter doublon : "${trend.title}"`);
        continue;
      }
      
      const { data: matches, error: matchError } = await supabase.rpc('match_processed_articles', {
        query_embedding: embedding,
        match_threshold: TREND_SEMANTIC_MATCH_THRESHOLD,
        p_site_id: site.id
      });

      if (matchError) {
        console.warn(`    ⚠️ match_processed_articles indisponible: ${matchError.message}`);
      }

      if (matches && matches.length > 0) {
        console.log(`    Ø Sujet sémantiquement trop proche déjà publié : "${matches[0].source_title}" (Similitude: ${Math.round(matches[0].similarity * 100)}%)`);
        continue;
      }
      
      // 3. Enrichissement recherche : Freudix fournit les métriques SEO,
      // LangSearch les sources fraîches et Tavily n'intervient que si elles sont faibles.
      const freudixMetrics = await getFreudixTrendMetrics(trend.title);
      const searchQuery = buildTrendResearchQuery(trend.title, keywords, spy.category);
      const research = await researchTrendTopic(searchQuery, site.default_language || 'fr');
      const sourceContext = buildTrendSourceContext(trend, freudixMetrics, research, spy.category);

      // 4. Insertion si tout est OK
      const { data: inserted, error } = await supabase.from('articles_queue').insert({
        wordpress_site_id: site.id,
        source_url: trend.articles[0]?.url || `https://www.google.com/search?q=${encodeURIComponent(trend.title)}`,
        source_title: trend.title,
        source_content_extract: sourceContext,
        source_type: 'trend',
        embedding: embedding,
        status: 'pending'
      }).select();

      if (!error && inserted && inserted.length > 0) {
        console.log(`📥 Tendance ajoutée : ${trend.title}`);
        titlesAddedThisRun.push(trend.title);
        await supabase
          .from('trend_spies')
          .update({ last_trend_detection_at: new Date().toISOString() })
          .eq('id', spy.id);
        
        added++;
      } else if (error) {
        console.error(`❌ Erreur insertion : ${error.message}`);
      }
    }
  }
  console.log('\n🏁 Fin Trend Spy.');
}

detectTrends().catch(console.error);
