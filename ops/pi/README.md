# Pi Runtime Files

Ces fichiers sont dedies a l'exploitation du retry worker sur Raspberry Pi.

## Fichiers

- `aspy-retry-worker.service` : service `systemd` recommande pour un worker resident
- `retry-worker.env.example` : exemple d'environnement a copier vers `/etc/aspy/retry-worker.env`

## Modes supportes

- `node src/retry-worker-pi.js`
  - mode boucle infinie
  - recommande avec `systemd`
- `node src/retry-worker-once.js`
  - traite un seul batch puis s'arrete
  - utile si vous preferez `cron`

## Regle d'exploitation

Au demarrage :

- filtrer quelques sites seulement
- garder `RETRY_WORKER_BATCH_SIZE=1` ou `2`
- observer les logs pendant 24h a 48h
- elargir ensuite
