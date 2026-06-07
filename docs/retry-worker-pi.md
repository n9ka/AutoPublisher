# Retry Worker sur Raspberry Pi

## But

Faire tourner un worker local sur le Raspberry Pi qui :

1. interroge Neon pour trouver des jobs de publication en échec
2. les reprend automatiquement
3. republie depuis l'IP du Pi / de la box
4. met à jour Supabase et Neon comme le retry local Windows

## Fichiers concernés

- `src/retry-worker.js` : boucle de polling
- `src/lib/publish-retry-service.js` : moteur partagé de retry
- `ops/retry-worker.service.example` : exemple de service systemd

## Variables d'environnement minimales

Le Pi doit disposer au minimum de :

- `PUBLISH_CACHE_DATABASE_URL`
- `PUBLISH_CACHE_ENABLED=true`
- `SUPABASE_URL`
- `SUPABASE_KEY`
- `ENCRYPTION_KEY`

Optionnel mais recommandé :

- `CACHE_DB_URL`
- `CACHE_DB_SERVICE_KEY`
- `WP_HEADER_PROFILE=default` ou `safe`

## Variables spécifiques au worker

- `RETRY_WORKER_POLL_MS`
  - fréquence de polling
  - défaut : `60000`
- `RETRY_WORKER_BATCH_SIZE`
  - nombre max de jobs traités par cycle
  - défaut : `3`
- `RETRY_WORKER_MAX_ATTEMPTS`
  - nombre max de retries avant de laisser le job de côté
  - défaut : `10`
- `RETRY_WORKER_SITE_URLS`
  - liste CSV de sites à reprendre
  - exemple : `https://zonementale.com,https://cfaw.fr`
- `RETRY_WORKER_SOURCE_KINDS`
  - liste CSV de types
  - valeurs utiles : `custom`, `manual`, `processor`
- `RETRY_WORKER_STATUSES`
  - liste CSV des statuts Neon à consommer
  - défaut : `failed`

## Comportement

Le worker :

1. claim un job Neon de façon atomique en passant son statut à `retrying`
2. tente la republication via le moteur partagé
3. en cas de succès :
   - publie sur WordPress
   - met à jour Supabase
   - marque Neon en `published`
4. en cas d'échec :
   - rembourse les crédits du retry
   - remet Neon en `failed`
   - continue sur les autres jobs

## Commande de test manuelle

```bash
node src/retry-worker.js
```

## Mise en service systemd

Exemple :

```bash
sudo cp ops/retry-worker.service.example /etc/systemd/system/aspy-retry-worker.service
sudo systemctl daemon-reload
sudo systemctl enable aspy-retry-worker
sudo systemctl start aspy-retry-worker
sudo systemctl status aspy-retry-worker
```

Logs :

```bash
journalctl -u aspy-retry-worker -f
```

## Recommandation de démarrage

Pour commencer en sécurité :

- limiter aux sites problématiques
- batch petit
- polling 60s

Exemple :

```bash
RETRY_WORKER_SITE_URLS=https://zonementale.com,https://cfaw.fr
RETRY_WORKER_SOURCE_KINDS=custom,processor
RETRY_WORKER_BATCH_SIZE=2
RETRY_WORKER_POLL_MS=60000
```

## Point connu

- l'indexation custom n'est pas encore rejouée automatiquement lors d'un retry réussi
