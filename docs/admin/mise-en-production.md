# Mise en production : déroulé complet

Public : Clevoa et la DSI du client, le jour où l'on passe en production. Objet : l'ordre des opérations, de l'accord
du client à la mise en service, avec une case par étape ; le détail de chaque geste est dans le document cité.

Règles : production toujours depuis un **tag publié** (`vX.Y.Z`), jamais une branche ni une `-rc.N` ; secrets saisis
directement dans la stack et rangés au coffre de la DSI, jamais dans un e-mail, un ticket ou une conversation ; aucune
donnée réelle copiée dans le dépôt.

## 1. Avant de commencer (décisions du client)

- [ ] Contrat signé ; avis du DPO sur les permissions Graph, l'accès en ligne (Cloudflare, Anthropic, OpenAI) et le
      journal d'audit ([sécurité § 4 et § 7](securite.md#4-télémétrie-clevoa)).
- [ ] Assistants autorisés : Claude (abonnement Team ou Enterprise de l'entreprise), ChatGPT seulement sur un abonnement
      d'entreprise ; décision accès en ligne oui ou non ([accès en ligne](acces-en-ligne.md)).
- [ ] Systèmes ouverts (`CONNECTORS_ENABLED`) et groupes de collaborateurs concernés (premier lot pilote).
- [ ] Recette passée en pré-production sur la version à installer : tests restants de
      l'[état des fonctionnalités § 3](../validation/etat-des-fonctionnalites.md#3-tests-restant-à-réaliser).

## 2. Serveur et réseau (DSI)

- [ ] Serveur Docker et Portainer, accès SSH avec `sudo` pour l'exploitation ([installation § 1](installation.md#1-prérequis)).
- [ ] Nom DNS interne et certificat ; hub joignable seulement par le reverse proxy https
      ([exploitation § 6](exploitation.md#6-reverse-proxy-nginx-https), [sécurité § 5](securite.md#5-ce-que-ladministrateur-doit-vérifier-au-déploiement)).
- [ ] Dossier de sauvegarde absolu propre à la production (ex. `/srv/mcp/backups-prod`), inclus dans la sauvegarde du
      serveur ([exploitation § 4](exploitation.md#4-sauvegarde)).
- [ ] Sorties réseau autorisées vers chaque système ouvert (Syracuse, Salesforce, Microsoft, Dropbox) et, avec l'accès
      en ligne, TCP 443 vers Cloudflare.

## 3. Applications d'identité (DSI)

- [ ] **Entra, application du portail** (SSO et SharePoint) propre à la production : URI de retour de production,
      permissions déléguées avec consentement administrateur, revendication facultative `given_name`
      ([SSO Entra ID](sso-entra.md), [configuration § 3](configuration.md#3-sharepoint--onedrive-microsoft-graph--vérifié-en-pré-production-un-compte)).
- [ ] **Entra, application de l'accès en ligne**, distincte de celle du portail : scope `mcp`, **affectation requise**
      limitée au lot pilote, adresses de retour de Claude (et de ChatGPT si autorisé) ([accès en ligne § 3](acces-en-ligne.md#3-entra-id--application-pour-claude)).
- [ ] **Salesforce** : application connectée de production, confirmation de l'intégrateur
      ([configuration § 2](configuration.md)).
- [ ] **Sage X3** : URL Syracuse de production, dossier, mode de connexion ([configuration § 1](configuration.md#1-sage-x3-24r1-api-rest-syracuse)).
- [ ] **Dropbox** : application créée par l'administrateur de l'équipe Dropbox Business du client, autorisations de
      lecture seules, passage en production ou utilisateurs activés ([configuration § 4](configuration.md#4-dropbox--vérifié-sur-un-compte-personnel-06112026)).

## 4. Secrets et coffre

- [ ] `ENCRYPTION_KEY` **neuve**, propre à la production (`openssl rand -hex 32`), rangée au coffre **avant** le
      premier démarrage ; ne jamais la changer ensuite.
- [ ] `CLEVOA_KEY` de production (obligatoire), `METRICS_TOKEN` si supervision.
- [ ] Export complet des variables de la stack au coffre, avec le nom de l'environnement.

## 5. Déploiement

- [ ] Portainer → stack depuis Git, référence `refs/tags/vX.Y.Z`, fichier `docker-compose.prod.yml`, GitOps désactivé
      ([installation § 4](installation.md#4-déploiement-avec-portainer-gitops)).
- [ ] Variables : `PUBLIC_URL` (https), `ENCRYPTION_KEY`, `BACKUP_DIR`, `CLEVOA_KEY`, `SSO_MODE=entra`, identifiants
      de chaque système ouvert, `CONNECTORS_ENABLED`, `INSTANCE_LABEL` ([`.env.example`](../../.env.example)).
- [ ] Premier démarrage : journal `Hub MCP vX.Y.Z · ENV: PRODUCTION · https://…`, conteneur « healthy », badge
      PRODUCTION sur le portail.

## 6. Accès en ligne (si retenu)

- [ ] Cloudflare : tunnel de production, nom public `<client>.<domaine>`, deux règles WAF, robots non bloqués
      ([runbook Cloudflare § 3 à § 5](cloudflare.md#3-tunnel-dun-client-par-environnement)).
- [ ] Stack : `CLOUDFLARE_TUNNEL=1`, `CLOUDFLARE_TUNNEL_TOKEN`, `CLOUDFLARE_PUBLIC_URL`, `ENTRAID_CLAUDE_*`
      ([accès en ligne § 5](acces-en-ligne.md#5-hub--variables-et-démarrage)) ; contrôles du runbook § 5.
- [ ] Owner Claude : connecteur `Clevoa – <client>` (sans « test ») dans l'organisation
      ([accès en ligne § 6](acces-en-ligne.md#6-claude--ajout-du-connecteur-par-lowner)).

## 7. Vérifications avant ouverture

- [ ] Un compte pilote : portail, connexion de chaque système, **Tout tester** en vert, une question par système dans
      l'assistant, sources citées.
- [ ] Cloisonnement : un second compte ne voit pas les données réservées du premier.
- [ ] Sauvegarde : un `users-*.json` et un `hub-*.db` présents dans `BACKUP_DIR` le lendemain ; restauration à blanc
      en pré-production dans le trimestre ([exploitation § 5](exploitation.md#5-restauration)).
- [ ] Supervision branchée (`/metrics` ou PRTG) ([exploitation § 11](exploitation.md#11-supervision-du-hub)).

## 8. Ouverture aux collaborateurs

- [ ] Lot pilote affecté dans Entra ; message d'information (droits inchangés, lecture seule, télémétrie réduite à des
      compteurs) et [fiche de démarrage rapide](../user/demarrage-rapide.md) avec l'adresse du portail et le nom du
      connecteur.
- [ ] Une semaine d'usage pilote sans incident bloquant, puis élargissement par groupes Entra.

## 9. Retour arrière

Revenir au tag précédent dans Portainer, même volume : [exploitation § 10](exploitation.md#10-mise-à-jour-et-retour-arrière).
En cas de doute sur les données : [restauration](exploitation.md#5-restauration). Désactiver l'accès en ligne :
`CLOUDFLARE_TUNNEL=0` puis redéployer.
