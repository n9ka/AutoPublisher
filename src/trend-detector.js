require('dotenv').config();
const { supabase } = require('./lib/supabase');
const { getDailyTrends } = require('./lib/trends');
const { researchTopic } = require('./lib/research');
const { getEmbedding, filterBestArticlesBatch } = require('./lib/gemini');
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

function buildTrendResearchQuery(title, rawKeywords, category) {
  const keywordList = parseKeywords(rawKeywords).slice(0, 2);
  const categoryHintMap = {
    t: 'technologie',
    b: 'business',
    m: 'sante',
    s: 'sport',
    e: 'divertissement',
    sc: 'science',
    w: 'international',
    n: 'national'
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

async function detectTrends() {
  console.log('🔍 Démarrage de Trend Spy (Recherche de tendances)...');

  const { data: spies, error: spyError } = await supabase
    .from('trend_spies')
    .select('*, wordpress_sites(*)')
    .eq('active', true);

  if (spyError) return console.error(spyError);

  for (const spy of spies) {
    const site = spy.wordpress_sites;
    console.log(`\n--- Espion pour : ${site.name} (Catégorie: ${spy.category}) ---`);

    // 1. Quota Check
    const today = new Date();
    today.setHours(0,0,0,0);
    
    const { count } = await supabase
      .from('articles_queue')
      .select('*', { count: 'exact', head: true })
      .eq('wordpress_site_id', site.id)
      .eq('source_type', 'trend')
      .gte('created_at', today.toISOString());

    const maxPerDay = spy.max_trends_per_day || 1;

    if (count >= maxPerDay) {
      console.log(`🛑 Quota Trends atteint (${count}/${maxPerDay}). Skip.`);
      continue;
    }

    const quotaLeft = maxPerDay - count;

    // 2. Fetch Trends
    const trends = await getDailyTrends(spy.category);
    if (trends.length === 0) {
      console.log('Ø Aucune tendance trouvée.');
      continue;
    }

    // 3. Préparation des tendances avec préférence keywords (souple)
    const keywords = spy.keywords || "";
    const parsedKeywords = parseKeywords(keywords);
    const maxPoolSize = Math.min(trends.length, Math.max(8, Math.min(20, quotaLeft * 4)));
    const exploratorySlots = parsedKeywords.length
      ? Math.min(2, Math.max(1, Math.floor(maxPoolSize * 0.25)))
      : 0;

    const scoredTrends = trends
      .map((trend) => ({ trend, score: scoreTrendByKeywords(trend, parsedKeywords) }))
      .sort((a, b) => b.score - a.score);

    let candidateTrends = [];
    if (parsedKeywords.length > 0) {
      const keywordHits = scoredTrends.filter((item) => item.score > 0);
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
      candidateTrends = trends.slice(0, maxPoolSize);
    }

    if (candidateTrends.length === 0) {
      console.log('Ø Aucune tendance trouvée.');
      continue;
    }

    console.log(
      `🧭 Préfiltre keywords: ${parsedKeywords.length ? parsedKeywords.join(', ') : 'aucun'} | ${candidateTrends.length}/${trends.length} tendances conservées.`
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
      if (added >= quotaLeft) break;

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
      
      // 3. Insertion si tout est OK
      const { data: inserted, error } = await supabase.from('articles_queue').insert({
        wordpress_site_id: site.id,
        source_url: trend.articles[0]?.url || `https://www.google.com/search?q=${encodeURIComponent(trend.title)}`,
        source_title: trend.title,
        source_content_extract: "", 
        source_type: 'trend',
        embedding: embedding,
        status: 'pending'
      }).select();

      if (!error && inserted && inserted.length > 0) {
        console.log(`📥 Tendance ajoutée : ${trend.title}`);
        titlesAddedThisRun.push(trend.title);
        
        // Recherche LangSearch (requête plus ciblée)
        const searchQuery = buildTrendResearchQuery(trend.title, keywords, spy.category);
        const context = await researchTopic(searchQuery);
        if (context) {
          await supabase.from('articles_queue')
            .update({ source_content_extract: context })
            .eq('id', inserted[0].id);
        }
        
        added++;
      } else if (error) {
        console.error(`❌ Erreur insertion : ${error.message}`);
      }
    }
  }
  console.log('\n🏁 Fin Trend Spy.');
}

detectTrends().catch(console.error);
