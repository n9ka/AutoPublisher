# Protections de transfert sans migration SQL

Version locale du 24 octobre 2026. Les workers conservent leurs réservations autour de la génération, de la facturation, des écritures WordPress et de la finalisation. Leur implémentation ne dépend plus de nouvelles tables ou fonctions Supabase.

`src/lib/site-operations.js` appelle le serveur Aspy sur `/api/internal/site-operations` avec `SUPABASE_KEY` comme secret serveur existant. Il doit correspondre à `SUPABASE_SERVICE_ROLE_KEY` côté Vercel. La route utilise le journal existant `execution_logs`, des réservations durables et des verrous transactionnels. Aucun nouveau secret partagé n'est créé.

Le défaut de connexion, une erreur HTTP ou une réponse invalide empêchent la publication. Aucun mode de compatibilité ne continue sans réservation. `ASPY_APP_URL` permet de remplacer l'origine par défaut `https://www.aspy.fr` pour un environnement contrôlé. Les redirections sont refusées afin de ne pas transmettre le secret à une autre destination. Le domaine sans `www` renvoie effectivement une redirection 307 : il ne doit pas servir de défaut pour ce protocole.

Un site en pause ou suspendu par un transfert diffère les opérations. Les refus sont traités sans facturation ni publication. Une mutation WordPress/sociale au résultat incertain conserve sa réservation ; elle nécessite une réconciliation avant un transfert, jamais une expiration automatique.

Les anciennes annonces sociales sont retenues au moyen des champs `status` et `error` déjà présents. `ASPY_TRANSFER_REVIEW:<identifiant>` interdit leur reprise par le worker jusqu'à validation explicite dans l'administration ; aucun champ SQL supplémentaire n'est utilisé.

Déployer le frontend Vercel avant cette version des workers, puis laisser terminer les anciennes exécutions. Garder `SITE_TRANSFERS_ENABLED` désactivé sur Vercel jusqu'au contrôle des exécutants concernés. La pause d'un site n'annule pas une ancienne tâche qui avait déjà chargé ses accès.

Les tests de la première version avec RPC ont été archivés en texte dans le dépôt frontend ; leurs anciens résultats ne valident pas cette version. Aucun test supplémentaire n'a été exécuté pendant ce remaniement. Les contrôles de syntaxe Node sont distincts d'un essai de publication.

## Vérification complémentaire du 24 octobre

Cinq tests du protocole API passent avec un transport simulé (`node --test test/site-transfer-protocol.test.cjs`) : refus d'un site suspendu, réservation conservée pendant l'effet externe puis libérée une seule fois, résultat externe incertain conservant la réservation, réponse invalide/propriétaire erroné/réseau indisponible refusés, origine canonique et refus des redirections. Syntaxe Node des 17 fichiers de protection vérifiée.

Contrôle de l'API en ligne sans effet en base : une requête JSON volontairement invalide renvoie 401 sans authentification et 400 avec la clé locale du moteur, avant toute opération SQL. Cela confirme l'authentification de cette clé, pas l'égalité avec le secret opaque GitHub Actions.

Au moment du contrôle, aucune exécution GitHub en cours/en attente. Le Raspberry Pi héberge toutefois un service de reprise actif, sur une ancienne révision, avec une modification locale du runtime qui limite les notifications Discord aux publications effectives. Préserver cette modification et la configuration lors de sa mise à jour ; ne pas faire de reset/pull aveugle. Son absence de filtre de sites impose de le prendre en compte avant activation.

Lecture seule du cache : 69 lignes pour Korigans, toutes déjà publiées ; une ligne `retrying` existe ailleurs dans le cache. Ni le processus concerné ni son résultat ne doivent être supposés arrêtés sur cette seule lecture. Aucun service n'a été arrêté ou redémarré pendant cet audit. Ces protections ne sont pas encore livrées ; l'activation des transferts reste bloquée.
