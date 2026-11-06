# Tests et analyses

Public : développeur et relecteur de PR. Objet : les suites de tests, la CI et la lecture d'un résultat d'analyse.

Tout tourne sans réseau ni compte réel : mocks amont pour le hub, bouchon d'entreprise pour le bout en bout, bouchons
rapides pour la charge. Aucun outil n'est lancé contre un système réel.

## 1. Suites de tests

| Suite | Commande | Contenu |
|---|---|---|
| Hub, pré-production | `cd hub && npm test` | 164 tests `node:test` (163 exécutés, 1 réservé à la production) |
| Hub, production | `cd hub && APP_ENV=production npm test` | même suite (162 exécutés, 2 réservés à la pré-production) |
| Backend Clevoa | `cd clevoa-backend && npm test` | 21 tests sans AWS : validation, séparation des clients, incidents, e-mails, silence, pannes de DynamoDB et SNS |
| Console de suivi | `cd clevoa-console && npm test` | 7 tests sur données de démonstration : authentification, lecture seule, CSP, états et historique |
| Bouchon, bout en bout | `cd clevoa-mcp-stub && npm test` | 11 tests : le vrai hub branché sur le bouchon (OAuth, SSO, PKCE, droits de Marie et Paul, télémétrie) |
| Sauvegarde et restauration | `BACKUP_DIR="$PWD/backups" ops/test-backup-restore.sh` (Docker, stack `docker-compose.dev.yml` démarrée) | scénarios A–L : sauvegardes successives, perte et corruption de `users.json`, sauvegarde invalide, mauvaise `ENCRYPTION_KEY` |
| Retour arrière | `ops/test-rollback.sh` (Docker ; `PREV=vX.Y.Z` choisit la version précédente) | courante → précédente → courante sur le même volume |
| Charge | `node loadtest/run.js` (≈ 15 min) | 6 scénarios sur bouchons, 50 collaborateurs ([outils](../../loadtest/README.md), [rapport](../validation/charge-v1.2.1.md)) |
| Documentation | `node ops/check-docs.js` | liens relatifs, ancres et chemins de fichiers cités dans tous les Markdown |

Un fichier par sujet dans `hub/test/` : `mcp`, `compat` (JSON-RPC brut), `online` (accès en ligne), `sso`,
`portal`, `docs` (Graph, Dropbox, MyReport, plafonds), `db`, `health`, `telemetry`, `diagnostic`, `backup`, `release`…
Mocks amont : `hub/test/helpers/upstream.js` (Salesforce, Entra, Graph, Dropbox, MyReport, Clevoa).
`hub/test/helpers/hub.js` démarre un hub de test avec un `DATA_DIR` temporaire.

## 2. Intégration continue

### Workflow `CI` (`.github/workflows/security-static.yml`)

Déclenché sur PR, push sur `main` et `dev`, chaque lundi sur `main`, ou à la main.

| Job | Outil | Ce qu'il vérifie | Bloque |
|---|---|---|---|
| tests | Node 24 | `npm audit` (production, niveau haut), puis hub (pré-production et production), bouchon, backend, console | oui |
| backup-restore | Docker Compose, `ops/test-backup-restore.sh` | sauvegarde, perte, restauration, mauvaise clé | oui |
| rollback | `ops/test-rollback.sh` | courante → dernier tag publié, puis → `v1.4.0-rc.2` (avant `hub.db`), → courante : connexions et identifiant conservés | oui |
| docs | `ops/check-docs.js` | liens internes, ancres, fichiers cités | oui |
| semgrep | `semgrep/semgrep:1.181.1` (`p/javascript`, `p/nodejs`, `p/security-audit`) | injection, XSS, crypto, Express | oui |
| codeql | `github/codeql-action` v4, `security-extended` | flux de données JavaScript (Security → Code scanning) | selon la configuration du dépôt |
| gitleaks | `ghcr.io/gitleaks/gitleaks:v8.30.1`, `.gitleaks.toml` | secrets dans tout l'historique | oui |
| trivy | `aquasecurity/trivy-action` v0.36.0 | dépendances (HIGH, CRITICAL corrigeables), configuration Docker, secrets | oui |
| trivy-image | idem, `scan-type: image` | image du hub : Alpine, Node, dépendances | oui |
| sbom | `npm sbom` (CycloneDX) + Trivy | inventaire des dépendances de production (artefact `sbom`), licences interdites | oui |

Les rapports sont des artefacts de chaque exécution. **Ne jamais publier un rapport hors de GitHub** : il cite le code.

`.gitleaks.toml` met en liste blanche des constantes inventées (tests, bouchon, exemples). Toute autre détection se
traite ; un ajout à la liste blanche exige une raison écrite dans le fichier et dans `CHANGELOG.md`.

### Workflow `Security - ZAP baseline (manual)`

Manuel uniquement. Démarre un hub de démonstration sur le runner (simulateurs, aucun compte réel), puis
`ghcr.io/zaproxy/zaproxy:2.16.1` en exploration **passive**. Rapports en artefacts ; les avertissements ne bloquent
pas (`-I`) et se trient à la main. Dernier résultat connu (23/10/2026, rapport non versionné) : 0 échec.

**Interdit** : lancer ZAP ou tout outil d'attaque contre un système du client ou d'un tiers sans autorisation écrite et
périmètre convenu.

## 3. Lire un résultat d'analyse

1. Un signalement est une hypothèse : retrouver le flux de données réel et les droits en amont.
2. Vrai défaut : correction minimale, test de régression, ligne dans `CHANGELOG.md`.
3. Faux positif : `// nosemgrep: <règle> -- <raison>` sur la ligne, ou entrée dans `.gitleaks.toml`, toujours avec la
   raison. Jamais de classement à la main dans l'interface GitHub.
4. Une CI verte ne prouve pas la sécurité : cloisonnement avec un compte restreint, révocation et justesse des réponses
   financières restent des tests humains ([état des fonctionnalités](../validation/etat-des-fonctionnalites.md)).

Historique des analyses : [audits d'octobre 2026](../history/audit-2026-10.md).
