# Sécurité

Public : l'administrateur du hub, la DSI et le DPO du client. Objet : les garanties du produit, ce qu'il faut vérifier
au déploiement, ce que la télémétrie envoie et ce que la base locale conserve.

Analyses automatiques : [tests et analyses](../developer/tests.md) ; dépendances : [dépendances](../developer/dependances.md) ;
audits passés : [historique](../history/audit-2026-10.md).

## 1. Cloisonnement des identités (règle non négociable)

Aucun compte de service, générique ou global, pour aucun outil connecté.

* `users.json` ne contient que des jetons **individuels**, rangés sous la clé MCP de chaque collaborateur avec son
  identité et le jour de sa dernière utilisation. Il est **chiffré AES-256-GCM** (`ENCRYPTION_KEY`, obligatoire,
  `openssl rand -hex 32`), déchiffré en mémoire seulement, écrit en 600 dans un volume en 700.
* Chaque appel MCP est authentifié par la clé de l'appelant. Le hub transmet **son** jeton en `Authorization: Bearer` :
  l'outil applique les droits de ce collaborateur.
* Le cache de structure (objets, champs) est par utilisateur et expire chaque nuit. Aucune donnée métier n'est cachée.
* SSO et SharePoint : l'id_token est vérifié par openid-client, **signature comprise**, puis par le hub (locataire, `oid`).
* Aucun jeton n'est lu dans l'environnement : les variables ne portent que les identifiants des applications OAuth.
* Exception : les **simulateurs** Sage X3 et MyReport, qui ne contactent aucun système.

Preuves : test `Cloisonnement` de `hub/test/mcp.test.js`, `hub/test/sso.test.js`, campagne de charge (0 violation sur
3 950 appels). Sur les systèmes réels : vérifié le 05/11/2026 avec un compte non administrateur sur Sage X3,
Salesforce et SharePoint ([journal C1–C3](../validation/journal-tests-reels.md)). **Limite** : Dropbox et deux
collaborateurs réels restent à faire ([état des fonctionnalités](../validation/etat-des-fonctionnalites.md)).

## 2. Lecture seule

* Salesforce : serveur MCP hébergé `SObject Reads` uniquement (URL verrouillée) ; les outils au nom d'écriture sont
  refusés avant transfert.
* Sage X3 : `$query`, `$details` et `$prototypes` uniquement, en GET.
* Microsoft Graph : GET uniquement, chemins et sites validés, redirections limitées aux hôtes Microsoft en https.
* Dropbox et MyReport : liste blanche d'outils.
* Noms d'objets validés (`^\w+$`) ; outils annotés `readOnlyHint`.

## 3. Accès MCP et portail

* La clé MCP passe **uniquement** dans l'en-tête `Authorization: Bearer`. Le paramètre `?key=` est ignoré.
* claude.ai web et mobile, et ChatGPT, passent par l'[accès en ligne](acces-en-ligne.md) (expérimental) : port séparé, jetons Entra ID,
  Cloudflare voit les échanges en clair.
* OAuth : PKCE S256 sur tous les flux ; callback lié au navigateur qui a lancé le flux. Les POST du portail refusent une
  autre origine.
* SSE : `POST /messages` exige la clé qui a ouvert la session (403 sinon).
* État des systèmes : en semaine de 7 h à 19 h, une requête `HEAD` sans identifiant toutes les 10 minutes vers chaque
  système réel (`PROBE=off` la désactive). `/api/status`, réservé aux collaborateurs identifiés, n'affiche qu'un état et
  un temps de réponse par système.
* Supervision (`/metrics`, `/metrics/prtg`) : n'existe qu'avec `METRICS_TOKEN` (24 caractères au moins, distinct des
  clés). Ni identité, ni clé, ni adresse, ni donnée métier.
* Limites par adresse IP et par minute (`TRUST_PROXY` = nombre de reverse proxys) : 20 diagnostics, 30 actions portail,
  60 `/api/me`, 60 `/api/status`, 30 `/metrics`, 60 départs et retours OAuth, 20 échecs d'authentification MCP.
* Routes MCP (`/mcp`, `/sse`, `/messages`) : 300 requêtes par minute **par clé**.
* Plafond d'appels sortants par connecteur, tous utilisateurs confondus : `MYREPORT_MAX_PER_MIN` (défaut 20),
  `SF_MAX_PER_MIN` (défaut illimité). Au-delà, erreur claire sans appel au système.
* En-têtes HTTP : CSP sans ressource externe, nosniff, anti-clickjacking, Referrer-Policy, Permissions-Policy,
  COOP/CORP ; `X-Powered-By` retiré.
* Conteneur : utilisateur `node`, capacités retirées, `no-new-privileges`, système de fichiers en lecture seule hors
  `/data` et `/tmp`. En production, `PUBLIC_URL` doit être en https.
* Journaux : jamais de clé, de jeton, d'argument d'outil ni de résultat. En `debug` : nom de l'outil, durée, statut.

## 4. Télémétrie Clevoa

**Finalité** : savoir quelles installations tournent, en quelle version, avec quels connecteurs (suivi de licence et
maintenance). Clevoa n'obtient aucun accès à l'installation : le hub ne retient de la réponse qu'un statut et une
éventuelle version minimale.

**Envoi** : `POST` vers `CLEVOA_URL` (défaut `https://clevoa.fr/api/v1/telemetry`, figé en production), en-tête
`X-Clevoa-Key`, sans redirection suivie ; au démarrage puis à 03:00, 09:00, 15:00 et 21:00 (plus 0 à 10 minutes au
hasard). Après un échec : essais à 1, 5 et 30 minutes. Une panne de Clevoa n'affecte pas le hub (journal
`[telemetry] échec`).

**Données** (le backend refuse tout autre champ, toute statistique mal formée et tout envoi de plus de 8 Ko) :

| Champ | Contenu |
|---|---|
| `installation` | UUID aléatoire, conservé dans `users.json` chiffré (il suit les sauvegardes) ; ne désigne ni le client ni une personne |
| `version`, `env`, `date` | version du hub, `PRODUCTION` ou `PRE-PROD`, date du jour |
| `connectors` | vrai = système réel configuré (un simulateur compte `false`) |
| `requests` | appels d'outils depuis le dernier envoi **réussi**, tous collaborateurs confondus |
| `seats` | nombre de collaborateurs ayant connecté au moins un outil (base de la licence) |
| `since` | début de la période couverte par `stats` |
| `stats` | par connecteur utilisé : appels ; erreurs par type (`auth`, `quota`, `timeout`, `unreachable`, `other`, `user` = erreur d'usage) ; collaborateurs distincts (`users`) et refusés sans aucun succès (`authUsers`) ; latences médiane et 95e centile en ms |

Les collaborateurs sont comptés par une empreinte salée de leur clé, jamais transmise. Ne quittent jamais le hub :
jetons, clés MCP, mots de passe, données métier, requêtes, réponses, noms et e-mails, journaux, adresses IP des postes.
`CLEVOA_KEY` identifie le **client**, l'identifiant ses installations ; une pré-production restaurée depuis la
production reste distincte (fiche par identifiant **et** par environnement). Dire « réduite à des compteurs », pas
« anonyme ».

**Destinataire et conservation** : Clevoa SASU. Le backend n'est pas encore déployé : écrit pour AWS Paris (table
DynamoDB chiffrée, journaux CloudWatch 90 jours), il doit passer sur Cloudflare (Workers, D1 en Europe), sans compte
AWS ([roadmap § 3](../roadmap-produit.md#3-axe-2--observabilité-et-maintenance)). Fiches et envois expirés après
400 jours ; e-mails d'incident (ouverture et fermeture seulement). Détail : [backend](../../clevoa-backend/README.md). Clevoa les consulterait dans une
[console](../../clevoa-console/README.md) en lecture seule, derrière Cloudflare Access.

**Désactivation** : `CLEVOA_KEY` vide la désactive hors production. En production, `docker-compose.prod.yml` exige la
clé ; son encadrement contractuel est un point ouvert ([licence § 11, point 8](../../LICENSE.md#11-points-à-valider-par-un-conseil-juridique)).
Un client qui bloque le flux garde un hub pleinement fonctionnel ; son installation apparaît silencieuse chez Clevoa.

**Données personnelles** : l'hébergeur du backend voit l'adresse IP du serveur. Sur une petite installation, un compteur peut se
rapprocher d'une personne. La qualification juridique (donnée personnelle ou non, registre des traitements, clause de
licence) est **à faire valider** par le juriste ou le DPO de Clevoa et du client avant la première production.

**Version minimale** : en dessous, le hub écrit `[telemetry] version … inférieure au minimum …` et continue de
fonctionner. La mise à jour reste une décision de l'administrateur ([mise à jour](exploitation.md#10-mise-à-jour-et-retour-arrière)).

## 5. Ce que l'administrateur doit vérifier au déploiement

| Point | Comment |
|---|---|
| Hub joignable seulement via le reverse proxy https | `HUB_PORT=127.0.0.1:8080`, nom DNS interne, `TRUST_PROXY` juste ([exploitation § 6](exploitation.md#6-reverse-proxy-nginx-https)) |
| `ENCRYPTION_KEY` et configuration au coffre, jamais avec les sauvegardes | [exploitation § 4](exploitation.md#4-sauvegarde) |
| Une `ENCRYPTION_KEY` et une `CLEVOA_KEY` par environnement | variables de chaque stack |
| Périmètre d'accès au portail | [SSO Entra ID](sso-entra.md), ou réseau interne / VPN ; tout compte du locataire peut obtenir une clé |
| Permissions Graph `Files.Read.All` et `Sites.Read.All` | revue M365 / DPO : les assistants voient les documents que voit le collaborateur |
| Départ d'un collaborateur, clé compromise | [exploitation § 8](exploitation.md#8-départ-dun-collaborateur-clé-compromise) |
| Aucun secret dans le dépôt ni les issues | Gitleaks en CI ; modèles d'issue « sans jeton ni donnée métier » |
| Journal d'audit (`AUDIT=on`) | seulement après avis du DPO et information des collaborateurs (§ 7) |

## 6. Ce qui reste à prouver

Compte restreint sur Sage X3 et Salesforce, révocation OAuth réelle, injection de prompts par des données non fiables,
exactitude financière sur un jeu de référence. État :
[état des fonctionnalités](../validation/etat-des-fonctionnalites.md).

## 7. Base d'exploitation et journal d'audit

`/data/hub.db` (SQLite, volume du hub, dossier en 700 et fichiers en 600, lisibles par `node` seul) contient :

| Donnée | Contenu | Identifie une personne ? | Conservation |
|---|---|---|---|
| Disponibilité | système, créneau de 10 minutes, état, temps de réponse p95 | non | 90 jours |
| Usage mensuel | mois, système, appels, erreurs | non | 24 mois |
| Collaborateurs actifs | mois, **pseudonyme** | pseudonyme | 24 mois |
| Journal d'audit, si `AUDIT=on` | date, pseudonyme, e-mail **chiffré** (`ENCRYPTION_KEY`), système, outil, résultat (`ok` ou catégorie d'erreur), durée | oui | `AUDIT_DAYS` (90 jours par défaut) |
| **Jamais** | arguments des outils, données renvoyées, jetons, clés MCP | | |

Le pseudonyme est un HMAC-SHA256 de l'identité (Entra, sinon clé MCP) avec une sous-clé d'`ENCRYPTION_KEY` : données
**pseudonymisées**, pas anonymes. Sans SSO, il change quand la clé MCP est régénérée.

**Journal d'audit : désactivé par défaut**, car c'est un traitement de données personnelles du client. Avant
`AUDIT=on`, le client doit au minimum (à valider par son DPO ; ceci n'est pas un avis juridique) :

1. fixer la **finalité** et la base légale ;
2. l'inscrire au **registre des traitements** ;
3. **informer les collaborateurs** : quoi, pourquoi, combien de temps, qui y accède ;
4. fixer la **durée** (`AUDIT_DAYS`) et les personnes autorisées à exporter.

**Accès** : aucune route HTTP, aucun écran ; export par un administrateur du serveur
([exploitation § 12](exploitation.md#12-disponibilité-usage-et-journal-daudit)). Le fichier exporté est en clair :
remise tracée, suppression après usage. Rien de la base ne part dans la télémétrie.

**Durée réelle** = `AUDIT_DAYS` + `BACKUP_KEEP_DAYS` (30 jours par défaut) : une ligne purgée est effacée du fichier
(`secure_delete`), mais survit dans les sauvegardes `hub-*.db` et dans `hub.db.avant-restauration` (à supprimer après
une restauration validée). L'annoncer aux collaborateurs. Dans les sauvegardes (600, root, `BACKUP_DIR`), compteurs,
outils et pseudonymes sont lisibles sans la clé, pas les e-mails d'audit.

**Panne de la base** : aucun outil n'est bloqué ; `clevoa_hub_db_up` et `clevoa_hub_db_write_failures_total` la
signalent ([exploitation § 11](exploitation.md#11-supervision-du-hub)).
