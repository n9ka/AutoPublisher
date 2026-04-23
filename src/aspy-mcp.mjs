#!/usr/bin/env node
/**
 * aspy-mcp.mjs — Serveur MCP Aspy pour Gemini CLI (et tout agent MCP-compatible)
 *
 * Expose 5 outils :
 *   list_sites        — Liste les sites WordPress actifs
 *   get_persona       — Persona rédactionnel d'un site
 *   get_recent_posts  — Derniers articles publiés (anti-doublons)
 *   get_site_config   — Credentials WP décryptés (pour vps-publisher.js)
 *   publish_article   — Publication complète déléguée à Aspy.fr
 *
 * Transport : stdio (compatible Gemini CLI, Claude Desktop, etc.)
 *
 * Setup : voir shared/aspy-mcp.md dans le vault Obsidian
 */

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const API_URL = process.env.ASPY_API_URL || 'https://aspy.fr';
const API_KEY = process.env.CATALOGUE_API_KEY;

if (!API_KEY) {
  console.error('[aspy-mcp] CATALOGUE_API_KEY manquant dans .env');
  process.exit(1);
}

async function api(method, path, { params = {}, body = null } = {}) {
  const url = new URL(`${API_URL}${path}`);
  Object.entries(params).forEach(([k, v]) => v !== undefined && url.searchParams.set(k, String(v)));

  const options = {
    method,
    headers: { 'x-api-key': API_KEY, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(30000),
  };
  if (body) {
    options.body = JSON.stringify(body);
    options.headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url.toString(), options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const TOOLS = [
  {
    name: 'list_sites',
    description: 'Liste tous les sites WordPress actifs du compte Aspy. À appeler en début de session pour connaître les sites disponibles.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_persona',
    description: 'Récupère le persona rédactionnel d\'un site (nom, ton, "je", tics de langage, spécialité). À lire avant de rédiger.',
    inputSchema: {
      type: 'object',
      required: ['site'],
      properties: {
        site: { type: 'string', description: 'Domaine ou fragment du site (ex: "cafel" ou "cafel.fr")' },
      },
    },
  },
  {
    name: 'get_recent_posts',
    description: 'Récupère les derniers articles publiés sur un site WordPress. Utiliser avant de choisir un sujet pour éviter les doublons.',
    inputSchema: {
      type: 'object',
      required: ['site'],
      properties: {
        site: { type: 'string', description: 'Domaine ou fragment du site' },
        limit: { type: 'number', description: 'Nombre d\'articles à retourner (défaut: 10, max: 50)' },
      },
    },
  },
  {
    name: 'get_site_config',
    description: 'Récupère les credentials WordPress décryptés d\'un site (pour vps-publisher.js). Rarement nécessaire directement.',
    inputSchema: {
      type: 'object',
      required: ['site'],
      properties: {
        site: { type: 'string', description: 'Domaine ou fragment du site' },
      },
    },
  },
  {
    name: 'publish_article',
    description: 'Publie un article sur WordPress via Aspy.fr. Aspy.fr gère la classification de rubrique, l\'image (Pexels) et la publication WP.',
    inputSchema: {
      type: 'object',
      required: ['site', 'html', 'title', 'slug'],
      properties: {
        site: { type: 'string', description: 'Domaine ou fragment du site' },
        html: { type: 'string', description: 'Contenu Gutenberg HTML de l\'article' },
        title: { type: 'string', description: 'Titre de l\'article' },
        slug: { type: 'string', description: 'Slug URL (ex: "mon-article-seo")' },
        excerpt: { type: 'string', description: 'Résumé court pour le SEO (optionnel)' },
        keywords: { type: 'string', description: 'Mots-clés SEO séparés par virgule (optionnel)' },
        status: { type: 'string', enum: ['draft', 'publish', 'future'], description: 'Statut de publication (défaut: draft)' },
        date: { type: 'string', description: 'Date de publication planifiée au format YYYY-MM-DD (optionnel, active status=future)' },
        image_url: { type: 'string', description: 'URL d\'une image à la une pré-générée (optionnel, sinon Pexels)' },
        image_alt: { type: 'string', description: 'Texte alternatif de l\'image (optionnel)' },
      },
    },
  },
];

const server = new Server(
  { name: 'aspy-vps', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    let text;

    switch (name) {
      case 'list_sites': {
        const data = await api('GET', '/api/vps/sites');
        text = `${data.sites.length} sites actifs :\n\n` +
          data.sites.map(s =>
            `• ${s.name}\n  URL: ${s.url}\n  Image: ${s.image_provider} | Statut défaut: ${s.default_status} | Autopilot: ${s.auto_seo_enabled ? 'actif' : 'inactif'}`
          ).join('\n\n');
        break;
      }

      case 'get_persona': {
        const data = await api('GET', '/api/vps/persona', { params: { site: args.site } });
        text = `Persona de ${data.site_name} (${data.site_url}) :\n\n${data.persona_text}`;
        break;
      }

      case 'get_recent_posts': {
        const data = await api('GET', '/api/vps/recent-posts', {
          params: { site: args.site, limit: args.limit ?? 10 },
        });
        if (data.posts.length === 0) {
          text = `Aucun article trouvé sur ${data.site}.`;
        } else {
          text = `${data.count} articles récents sur ${data.site} :\n\n` +
            data.posts.map((p, i) =>
              `${i + 1}. "${p.title}"\n   Date : ${p.date} | Slug : ${p.slug}\n   ${p.excerpt}`
            ).join('\n\n');
        }
        break;
      }

      case 'get_site_config': {
        const data = await api('GET', '/api/vps/site-config', { params: { site: args.site } });
        // Ne pas exposer le mot de passe en clair dans la réponse texte
        text = `Config site ${data.wp_url} :\n  Utilisateur WP : ${data.wp_user}\n  Mode connexion : ${data.connection_mode}\n  Bridge key : ${data.bridge_key ? 'configurée' : 'non'}`;
        break;
      }

      case 'publish_article': {
        const data = await api('POST', '/api/vps/publish', {
          body: {
            site: args.site,
            html: args.html,
            metadata: {
              title: args.title,
              slug: args.slug,
              excerpt: args.excerpt ?? '',
              keywords: args.keywords ?? '',
              imageAlt: args.image_alt ?? args.title,
            },
            status: args.status ?? 'draft',
            date: args.date ?? undefined,
            imageUrl: args.image_url ?? undefined,
          },
        });
        text = `✅ Article ${data.status === 'future' ? 'planifié' : args.status === 'publish' ? 'publié' : 'enregistré en brouillon'} !\n\nLien : ${data.link}\nPost ID : ${data.post_id}\nRubrique ID : ${data.category_id ?? 'non classé'}\nImage : ${data.has_image ? '✓ uploadée' : '✗ aucune'}`;
        break;
      }

      default:
        throw new Error(`Outil inconnu : ${name}`);
    }

    return { content: [{ type: 'text', text }] };

  } catch (err) {
    return {
      content: [{ type: 'text', text: `❌ Erreur (${name}) : ${err.message}` }],
      isError: true,
    };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('[aspy-mcp] Serveur démarré (stdio)');
