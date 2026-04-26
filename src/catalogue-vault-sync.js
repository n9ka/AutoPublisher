require('dotenv').config()
const fs = require('fs')
const path = require('path')

const API_KEY = process.env.CATALOGUE_API_KEY
const BASE_URL = process.env.CATALOGUE_BASE_URL || 'https://backlink.aspy.fr'
const SLUGS = (process.env.CATALOGUE_SLUGS || '').split(',').map(s => s.trim()).filter(Boolean)
const VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH || '/home/neka/obsidian-vault'
const CATALOGUE_DIR = path.join(VAULT_PATH, 'shared', 'catalogue-sites')
const INDEX_FILE = path.join(CATALOGUE_DIR, '_index.md')

if (!API_KEY || SLUGS.length === 0) {
  console.error('[catalogue-sync] CATALOGUE_API_KEY ou CATALOGUE_SLUGS manquant')
  process.exit(1)
}

function cleanDomain(url) {
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
}

function domainToFilename(url) {
  return cleanDomain(url).replace(/\./g, '-') + '.md'
}

function formatDate(iso) {
  return iso ? iso.split('T')[0] : ''
}

async function fetchSites(slug) {
  const url = `${BASE_URL}/api/catalogue/${slug}?limit=500`
  const res = await fetch(url, { headers: { 'x-api-key': API_KEY } })
  if (!res.ok) {
    throw new Error(`API ${slug} → ${res.status} ${res.statusText}`)
  }
  const json = await res.json()
  return json.sites || []
}

function buildFrontmatter(site, slug) {
  const m = site.majestic || {}
  const lines = [
    '---',
    `id: "${site.id}"`,
    `slug: "${slug}"`,
    `url: "${site.url}"`,
    `url_visible: ${site.url_visible}`,
    `title: ${site.title ? `"${site.title.replace(/"/g, '\\"')}"` : '""'}`,
    `description: ${site.description ? `"${site.description.replace(/"/g, '\\"')}"` : '""'}`,
    `thematiques:`,
    ...(site.thematiques || []).map(t => `  - ${t}`),
    `active: true`,
    `include_global: ${site.include_global ?? false}`,
    ``,
    `# Métriques Majestic`,
    `tf: ${m.mj_trust_flow ?? 'null'}`,
    `cf: ${m.mj_citation_flow ?? 'null'}`,
    `rd: ${m.mj_ref_domains ?? 'null'}`,
    `ttf: "${m.mj_ttf_topic || ''}"`,
    ``,
    `# Trafic`,
    `traf_semrush: ${site.traf_semrush ?? 'null'}`,
    `kw_semrush: ${site.kw_semrush ?? 'null'}`,
    `gsc_clicks_28d: ${site.gsc_clicks_28d ?? 'null'}`,
    ``,
    `# Tarifs`,
    `price_with_redaction: ${site.price_with_redaction}`,
    `price_sensitive: ${site.price_sensitive ?? 'null'}`,
    `accepts_sensitive: ${site.accepts_sensitive}`,
    ``,
    `# Conditions`,
    `mots_min: ${site.mots_min}`,
    `nb_liens_max: ${site.nb_liens_max}`,
    `dofollow: ${site.dofollow}`,
    `mention_sponsored: ${site.mention_sponsored}`,
    `affichage_homepage: ${site.affichage_homepage}`,
    `has_discover: ${site.has_discover}`,
    `has_gmb: ${site.has_gmb}`,
    ``,
    `# Meta`,
    `note_interne: ${site.note_interne ? `"${String(site.note_interne).replace(/"/g, '\\"')}"` : 'null'}`,
    `updated_at: "${new Date().toISOString()}"`,
    `source: backlink.aspy.fr`,
    '---',
  ]
  return lines.join('\n')
}

function buildSiteContent(site, slug) {
  const m = site.majestic || {}
  const fm = buildFrontmatter(site, slug)

  return `${fm}

# ${site.title || site.url}

**Domaine :** ${site.url}
**Thématiques :** ${(site.thematiques || []).join(' · ') || '—'}

## Tarifs

| Type | Prix |
|------|------|
| Avec rédaction | ${site.price_with_redaction} € |
| Thématique sensible | ${site.price_sensitive ? site.price_sensitive + ' €' : '—'} |

## Métriques

| Métrique | Valeur |
|----------|--------|
| TF | ${m.mj_trust_flow ?? '—'} |
| CF | ${m.mj_citation_flow ?? '—'} |
| RD | ${m.mj_ref_domains ?? '—'} |
| TTF | ${m.mj_ttf_topic || '—'} |
| Trafic SEMrush | ${site.traf_semrush ? site.traf_semrush.toLocaleString('fr-FR') : '—'} |
| Mots-clés SEMrush | ${site.kw_semrush ? site.kw_semrush.toLocaleString('fr-FR') : '—'} |
| Clics GSC 28j | ${site.gsc_clicks_28d ? site.gsc_clicks_28d.toLocaleString('fr-FR') : '—'} |

## Conditions

- Mots minimum : ${site.mots_min}
- Liens max : ${site.nb_liens_max}
- DoFollow : ${site.dofollow ? 'oui' : 'non'}
- Mention sponsorisé : ${site.mention_sponsored ? 'oui' : 'non'}
- Affichage homepage : ${site.affichage_homepage ? 'oui' : 'non'}
- Google Discover : ${site.has_discover ? '✅' : 'non'}
- Google My Business : ${site.has_gmb ? '✅' : 'non'}
${site.note_interne ? `\n## Note interne\n\n${site.note_interne}\n` : ''}`
}

function buildIndex(allSites, totalSites) {
  const now = new Date().toISOString()
  const sorted = [...allSites].sort((a, b) => cleanDomain(a.url).localeCompare(cleanDomain(b.url)))

  const list = sorted.map(s => {
    const domain = (s.url || '').replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '')
    const tf = s.majestic?.mj_trust_flow ?? '—'
    const themes = (s.thematiques || []).join(', ') || '—'
    return `- ${domain} · ${s.price_with_redaction}€ · TF ${tf} · ${themes}`
  }).join('\n')

  return `---
updated_at: "${now}"
total_sites: ${totalSites}
source: backlink.aspy.fr
---

# Catalogue de sites

> Mis à jour automatiquement toutes les heures depuis backlink.aspy.fr.
> Lecture seule — modifications via l'API ou le dashboard Aspy.

## Sites (${totalSites})

${list}

---
> Les vues Dataview ci-dessous sont réservées à Obsidian.

## Vue complète

\`\`\`dataview
TABLE url AS "Site", thematiques AS "Thématiques", price_with_redaction AS "Prix €", tf AS "TF", rd AS "RD", dofollow AS "DoFollow"
FROM "shared/catalogue-sites"
WHERE file.name != "_index" AND file.name != "_template" AND file.name != "_exemple-sport-com"
WHERE active = true
SORT file.name ASC
\`\`\`
`
}

function updateIndex(allSites, totalSites) {
  fs.writeFileSync(INDEX_FILE, buildIndex(allSites, totalSites), 'utf8')
}

async function syncSlug(slug) {
  console.log(`[catalogue-sync] Sync slug="${slug}"...`)
  let sites
  try {
    sites = await fetchSites(slug)
  } catch (err) {
    console.error(`[catalogue-sync] ⚠️ Erreur fetch ${slug} :`, err.message)
    return []
  }

  console.log(`[catalogue-sync] ${sites.length} sites reçus pour "${slug}"`)

  const existingFiles = fs.readdirSync(CATALOGUE_DIR)
    .filter(f => !f.startsWith('_') && f.endsWith('.md'))

  const generatedFiles = new Set()

  for (const site of sites) {
    const filename = domainToFilename(site.url)
    generatedFiles.add(filename)
    const filepath = path.join(CATALOGUE_DIR, filename)
    fs.writeFileSync(filepath, buildSiteContent(site, slug), 'utf8')
  }

  for (const existing of existingFiles) {
    if (!generatedFiles.has(existing)) {
      fs.unlinkSync(path.join(CATALOGUE_DIR, existing))
      console.log(`[catalogue-sync] 🗑️ Supprimé : ${existing}`)
    }
  }

  return sites
}

async function main() {
  console.log(`[catalogue-sync] Démarrage — slugs: ${SLUGS.join(', ')}`)

  if (!fs.existsSync(CATALOGUE_DIR)) {
    fs.mkdirSync(CATALOGUE_DIR, { recursive: true })
    console.log(`[catalogue-sync] Répertoire créé : ${CATALOGUE_DIR}`)
  }

  const allSites = []
  for (const slug of SLUGS) {
    const sites = await syncSlug(slug)
    allSites.push(...sites)
  }

  updateIndex(allSites, allSites.length)

  console.log(`[catalogue-sync] ✅ Terminé — ${allSites.length} sites générés dans ${CATALOGUE_DIR}`)
}

main().catch(err => {
  console.error('[catalogue-sync] Erreur fatale :', err)
  process.exit(1)
})
