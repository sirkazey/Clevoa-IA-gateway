# Installation

Pour l'administrateur qui déploie Clevoa AI Gateway : sur un poste (démonstration), avec Portainer (recommandé) ou à la
main avec Docker Compose. Exploitation : [exploitation](exploitation.md) ; connecteurs : [configuration](configuration.md).

## 1. Prérequis

* **Serveur** : Linux, Docker Engine et Docker Compose v2 ; Portainer pour le déploiement GitOps (recommandé).
* **Ressources** : 150 Mo de RAM et une fraction de cœur pour 50 collaborateurs ([campagne de charge](../validation/charge-v1.2.1.md)).
* **Réseau sortant** : HTTPS vers Salesforce, Microsoft (login et Graph), Dropbox, MyReport Server et `clevoa.fr`.
* **Réseau entrant** : les collaborateurs joignent le reverse proxy https, en réseau interne ou VPN (pas d'exposition
  sur internet ; un nom interne suffit).
* **Nom DNS et certificat** : un nom par environnement (ex. `mcp-preprod.` et `mcp.`) ; en production, `PUBLIC_URL` en https.
* **Secrets** : `ENCRYPTION_KEY` générée une fois par environnement (`openssl rand -hex 32`) et rangée au coffre ;
  identifiants des applications OAuth ; `CLEVOA_KEY` fournie par Clevoa pour la production.

## 2. Démarrage sur un poste (Docker Desktop)

Le **bouchon d'entreprise** `clevoa-mcp-stub` fournit des données fictives et deux collaborateurs (Marie, DAF ; Paul,
commercial).

```bash
cp .env.example .env        # renseigner ENCRYPTION_KEY ; PUBLIC_URL=http://localhost:8080 est déjà là
docker compose -f docker-compose.dev.yml up -d --build
open http://localhost:8080  # EXACTEMENT l'adresse de PUBLIC_URL (pas 127.0.0.1) : cookie et retours OAuth y sont liés
```

Les mires du bouchon s'ouvrent sur `http://localhost:4000`. Identifiants fictifs : Sage X3 `MDUPONT` / `SYR-MARIE-2026`,
MyReport `MR-MARIE-2026` ([README du bouchon](../../clevoa-mcp-stub/README.md)). Renseigner une variable réelle
(ex. `SF_LOGIN_URL`, `SF_CLIENT_ID`) rebranche ce seul système sur le vrai.

Règles du `.env` : jamais de commentaire sur la même ligne qu'une valeur vide (Compose le lirait comme la valeur) ;
une variable vide garde la valeur par défaut du fichier Compose.

Volume hérité d'une ancienne version (propriétaire root) : `docker compose -f docker-compose.dev.yml down -v`, **sur un
poste de développement uniquement** (sur un serveur, `down -v` détruit `users.json`).

Sans bouchon (simulateurs internes Sage X3 et MyReport) : `docker compose up -d --build`.

## 3. Deux environnements étanches

| | Pré-production | Production |
|---|---|---|
| Référence Git | tag à recetter (`refs/tags/vX.Y.Z-rc.N` ou `vX.Y.Z`) | tag publié (`refs/tags/vX.Y.Z`), jamais une branche |
| Fichier Compose | `docker-compose.dev.yml` | `docker-compose.prod.yml` |
| Conteneurs | `mcp-hub-preprod`, `mcp-stub`, `mcp-backup-preprod`, `mcp-proxy-preprod` (profil `proxy`) | `mcp-hub-prod`, `mcp-backup-prod`, `mcp-proxy-prod` (profil `proxy`) |
| Particularités | `LOG_LEVEL=debug` ; API sortantes vers le bouchon par défaut | `APP_ENV=production` : `PUBLIC_URL` https et `CLEVOA_KEY` obligatoires, télémétrie figée sur `https://clevoa.fr`, conteneur sans privilèges en lecture seule, connecteur non configuré non exposé |

Les deux fichiers étendent `docker-compose.yml` (lancé seul : démonstration avec simulateurs internes). Chaque stack a
son volume `mcp-data`, donc son `users.json` : les jetons d'un environnement ne sont jamais visibles dans l'autre.

## 4. Déploiement avec Portainer (GitOps)

Une fois par environnement, **depuis Git uniquement** : un compose collé à la main laisse `mcp-backup` sans les
scripts `ops/`.

1. **Stacks → Add stack → Repository** : URL du dépôt (identifiants Git s'il est privé), *Repository reference* = le
   tag choisi (ex. `refs/tags/vX.Y.Z`, § 6), *Compose path* = le fichier du § 3.
2. **GitOps updates** : **désactivé**. La stack ne change que quand l'administrateur choisit une autre version
   ([exploitation § 10](exploitation.md#10-mise-à-jour-et-retour-arrière)).
3. **Environment variables** (liste commentée : [`.env.example`](../../.env.example)) :
   * partout : `PUBLIC_URL`, `ENCRYPTION_KEY`, `BACKUP_DIR` en chemin **absolu**, distinct par environnement
     (ex. `/srv/mcp/backups-prod`) ;
   * en production : `CLEVOA_KEY` (si `clevoa.fr` ne répond pas, le hub journalise `[telemetry] échec` et continue) ;
   * en pré-production avec le bouchon : `BROWSER_URL_REWRITE=http://mcp-stub:4000=>http://<hôte-préprod>:4000` ;
   * facultatif : `MCP_SERVER_NAME` et `INSTANCE_LABEL` ([configuration § 0](configuration.md#0-le-fichier-env-et-les-uri-de-rappel)).
4. **https** : nginx fourni (profil `proxy`) ou reverse proxy existant, voir
   [exploitation § 6](exploitation.md#6-reverse-proxy-nginx-https).
5. **Premier démarrage** : le journal affiche `Hub MCP vX.Y.Z · ENV: PRE-PROD · https://…`, le portail le badge de
   l'environnement, et Portainer le hub « healthy ».

**Pré-production avec des systèmes réels** : une variable vide garde le bouchon. Pour un vrai système, renseigner :

* Microsoft (SharePoint et SSO) : `MS_LOGIN_URL=https://login.microsoftonline.com`, `GRAPH_URL=https://graph.microsoft.com/v1.0` ;
* Dropbox : `DROPBOX_AUTH_URL=https://www.dropbox.com`, `DROPBOX_API_URL=https://api.dropboxapi.com`,
  `DROPBOX_MCP_URL=https://mcp.dropbox.com/mcp`, `DROPBOX_CONTENT_URL=https://content.dropboxapi.com` ;
* Clevoa : `CLEVOA_URL` ;
* Sage X3 : garder les lignes `SAGE_OAUTH_*` présentes et vides, sinon le portail propose l'IdP simulé du bouchon au
  lieu du formulaire Syracuse.

## 5. Déploiement manuel (Docker Compose)

Depuis un clone du dépôt, avec un `.env` à côté :

```bash
git fetch --tags && git checkout vX.Y.Z                          # une version publiée, jamais une branche
docker compose -f docker-compose.prod.yml up -d --build          # production
docker compose --profile proxy -f docker-compose.prod.yml up -d  # avec le nginx fourni (HUB_PORT=127.0.0.1:8080)
docker compose -f docker-compose.prod.yml config                 # configuration résolue, sans rien déployer
```

Après toute modification de `.env`, relancer `up -d` : les connexions des collaborateurs sont conservées.

## 6. Cycle de livraison et versions

* Un seul code pour tous les clients, sans branche ni fork par client. Chaque installation a sa stack, ses variables,
  ses secrets, son volume et son identifiant d'installation ; elle ne change de version que sur décision de son administrateur.
* Une version est un **tag Git** `vX.Y.Z` (ou `vX.Y.Z-rc.N`, version candidate) posé sur `main`, avec une Release
  GitHub ; portail, journaux, diagnostic et télémétrie affichent ce numéro. Liste : Releases GitHub et
  [`CHANGELOG.md`](../../CHANGELOG.md).
* Un tag publié n'est jamais déplacé ni supprimé : convention seulement, tant que la protection des tags `v*` n'est pas
  posée sur GitHub (Settings → Rules).
* Le tag fige le code, les dépendances (`npm ci`) et l'image de base Node (par empreinte) : reconstruire un tag redonne
  une image de même contenu. Le nginx optionnel suit l'étiquette `nginx:1.28-alpine`.

**Publier une version (Clevoa)** : livraison selon [contribuer § 1](../CONTRIBUTING.md#1-code) (CI verte, contrôles de
sécurité compris, PR `dev` → `main`), puis GitHub → Releases → *Draft a new release* → tag `vX.Y.Z` sur `main`, texte du
changelog. Annoncer la version aux clients avec son urgence. Clevoa peut déclarer une version minimale dans le backend
de télémétrie : les hubs en dessous l'écrivent dans leurs journaux.

**Installer une version chez un client (administrateur du client)**

1. Pré-production : sauvegarde, puis *Repository reference* = le nouveau tag ([exploitation § 10](exploitation.md#10-mise-à-jour-et-retour-arrière)).
2. Recette : portail, « Tester » sur chaque outil, quelques questions dans l'assistant.
3. Production : même opération, puis même contrôle.

**Version corrective de sécurité** : une faille haute ou critique corrigeable signalée par la CI (Trivy, `npm audit`,
y compris le passage hebdomadaire du lundi sur `main`) donne une version `vX.Y.Z+1` limitée à l'image ou au lockfile.
Délai cible : 15 jours, 72 heures pour une faille critique exploitable à distance ; à confirmer dans le contrat de
maintenance.

## 7. Première mise en service auprès des collaborateurs

1. Choisir l'assistant autorisé. Claude Desktop, par clé sur un poste du réseau ou en VPN, est vérifié en réel ;
   Claude web et mobile et ChatGPT aussi, par l'[accès en ligne](acces-en-ligne.md), expérimental : à annoncer comme
   tel. Claude Code et Copilot ne sont testés qu'au niveau du protocole
   ([état des fonctionnalités](../validation/etat-des-fonctionnalites.md)).
2. Informer les collaborateurs (droits inchangés, jetons chiffrés et individuels, télémétrie réduite à des compteurs :
   [sécurité](securite.md)) ; mettre à jour le registre des traitements si la DSI le tient.
3. Onboarding en trois gestes ([guide utilisateur](../user/guide-utilisateur.md)) : se connecter aux outils, vérifier
   les voyants, copier le bloc dans l'assistant.
