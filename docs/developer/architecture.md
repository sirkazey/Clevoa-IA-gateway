# Architecture

Pour le développeur qui reprend le code. Un seul conteneur Node 24, cinq dépendances directes (`@modelcontextprotocol/sdk`,
`express`, `zod`, `express-rate-limit` pour toutes les limites de débit, `openid-client` pour le SSO et SharePoint ; registre et
politique : [dépendances](dependances.md)), un fichier d'état chiffré (`users.json`) et, depuis la 1.5, une base
d'exploitation SQLite intégrée à Node (`hub.db`, sans dépendance ni service), aucune abstraction. Les connecteurs sont des
modules, pas des services.

## 1. Vue d'ensemble

```
Assistant IA (Claude Code, Claude Desktop, ChatGPT, Copilot)
        │  MCP : SSE (/sse + /messages) ou Streamable HTTP (/mcp) + Authorization: Bearer <clé perso>
        ▼
┌─────────────────── mcp-hub (1 conteneur, Node 24) ───────────────────┐
│ server.js      identité (clé), outils MCP, portail, diagnostic, API  │
│ oauth.js       flux OAuth2 code + PKCE + refresh, tous connecteurs   │
│ sso.js         SSO Entra ID (pseudo-connecteur OIDC, modes mock/entra)│
│ store.js       users.json chiffré AES-256-GCM, par clé MCP            │
│ cache.js       structure des tables en mémoire, par utilisateur,     │
│                expirée chaque nuit à 03:00                           │
│ mcpclient.js   client MCP partagé par les connecteurs proxy          │
│ telemetry.js   compteurs envoyés à Clevoa au démarrage puis toutes   │
│                les 6 h (statistiques par connecteur, essais bornés)  │
│ version.js     VERSION stricte + APP_ENV (PRODUCTION / PRE-PROD)     │
│ health.js      état des systèmes : appels de la dernière heure et    │
│                vérification HEAD sans identifiant (lun-ven 7-19 h)   │
│ diagnostic.js  rapport de support lancé par l'administrateur, sans   │
│                secret ni donnée métier (docker exec, lecture seule)  │
│ crypto.js      AES-256-GCM (enc1:) et pseudonymes HMAC, ENCRYPTION_KEY│
│ db.js          hub.db (node:sqlite, WAL) : disponibilité, usage,     │
│                audit ; purge, instantané horaire, migrations         │
│ admin.js       lecture de hub.db par l'administrateur (docker exec)  │
│ connectors/    salesforce · sagex3 · sharepoint · dropbox · myreport │
│ public/        index.html, le portail                                │
│ test/          node:test, amont mocké, 138 tests                     │
└───┬─────────────┬───────────────┬───────────────┬───────────────┬────┘
    ▼ MCP HTTP    ▼ REST Syracuse ▼ Graph (GET)   ▼ MCP HTTP      ▼ MCP SSE
 Salesforce    Sage X3 24R1    SharePoint      Dropbox (MCP    MyReport Server
 (SObject Reads) (ou simulateur) OneDrive      officiel)       (ou simulateur)
```

En pré-production, le conteneur `mcp-stub` ([`clevoa-mcp-stub/`](../../clevoa-mcp-stub/README.md)) imite les cinq
systèmes, Entra ID et le backend Clevoa ; 11 tests de bout en bout branchent le vrai hub dessus.

## 2. Identité et état

* **Clé MCP personnelle** : chaîne aléatoire, cookie `mcp_key` pour le portail, en-tête `Authorization: Bearer` pour
  les clients MCP (jamais dans l'URL). Avec le SSO, une clé n'est utilisable qu'une fois liée à une identité Entra
  (`oid` + locataire) ; les clés temporaires de navigateur ne sont jamais persistées et sont purgées.
* **`store.js`** : `users.json` = `{ users: { <clé>: { createdAt, email, sso?, salesforce?, sagex3?, … } } }`, chiffré
  sur disque (`enc1:` + AES-256-GCM, `ENCRYPTION_KEY`), déchiffré en mémoire. Un fichier en clair est relu et rechiffré
  à la première écriture. Seules les entrées porteuses d'une identité ou d'un jeton sont écrites. API : `get`, `create`,
  `setTokens`, `clearTokens`, `findSso`, `setSso`, `rotate`, `remove`, `purge`, `seats`.
* **`oauth.js`** : un routeur pour tous les connecteurs (`/auth/<système>` et `/auth/<système>/callback`), code + PKCE
  S256, `state` lié au cookie du navigateur qui a lancé le flux, refresh partagé (une promesse par utilisateur et par
  système), `withToken(connecteur, clé, fn)` qui relit le store et rejoue l'appel après un refresh sur 401. Un refresh
  token révoqué efface l'entrée et demande une reconnexion. Connecteurs OIDC (`issuer` : SSO, SharePoint) : échange et
  refresh par openid-client, id_token vérifié (émetteur, audience, expiration, **signature** avec les clés de l'annuaire) ;
  autres connecteurs : OAuth2 simple, jeton opaque vérifié par le système lui-même.
* **`sso.js`** : pseudo-connecteur OIDC (`openid profile email`), contrôles propres au hub après openid-client (locataire,
  `oid`, émetteur, audience, expiration), `bindIdentity` (clé fraîche à la première liaison), `assertSame` (jetons SharePoint
  du même compte), enchaînement silencieux vers SharePoint (`prompt=none`), déconnexion Microsoft.
* **`cache.js`** : `Map` « clé:système » → structure, invalidée à la coupure de 03:00 (`TZ`).
* **`db.js`** (1.5) : `/data/hub.db`, SQLite intégré à Node (`node:sqlite`, journal WAL, `synchronous=normal`). Données
  d'exploitation seulement, jamais une connexion : `availability` (une mesure par système et par créneau de 10 minutes,
  90 jours), `usage` et `usage_users` (appels, erreurs et pseudonymes actifs par mois, 24 mois), `audit` (si `AUDIT=on`,
  e-mail chiffré par `crypto.js`, `AUDIT_DAYS`). Schéma versionné par `pragma user_version` : une migration s'ajoute en
  fin de `MIGRATIONS`, jamais modifiée une fois publiée. Ouverte et vérifiée (`quick_check`) avant l'annonce du démarrage ;
  toute erreur la désactive sans toucher aux outils (`safely`). Instantané `hub-instantane.db` toutes les 6 heures
  (`backup()` puis renommage), copié par `mcp-backup`. Lu par `admin.js` (`docker exec`), `/api/status`, `/metrics`.
  `users.json` reste la seule source des identités et des jetons : un retour à la 1.4 ignore simplement `hub.db`.
* Autres états en mémoire : flux OAuth en cours, compteurs de débit par IP, sessions SSE (`sessionId` → transport +
  clé), compteur de télémétrie. Sur disque, `users.json` porte aussi l'identifiant aléatoire d'installation (télémétrie).

## 3. Serveur MCP et transports

`buildServer(clé)` crée un `McpServer` par connexion, nommé `MCP_SERVER_NAME` (défaut `clevoa-gateway`), enregistre les outils de tous les
connecteurs actifs (`readOnlyHint`), compte l'appel pour la télémétrie, applique le plafond du connecteur
(`maxPerMinute`, tous utilisateurs confondus), résout le jeton via `withToken`, et termine chaque résultat par la
ligne `Source : <système> · <dossier | sandbox | production>`. Les contenus MCP non textuels (`image`, `resource`)
sont relayés tels quels. Une erreur d'outil devient `isError` avec le message ; elle ne fait jamais tomber le processus.

* **Streamable HTTP** (`POST /mcp`) : sans état, un serveur jetable par requête.
* **SSE** (`GET /sse`, `POST /messages?sessionId=`) : transport historique, la session n'est utilisable qu'avec la clé
  qui l'a ouverte. À retirer en premier quand tous les assistants cibles seront sur Streamable HTTP.
* Révisions du protocole : celles du SDK (2024-10-07 à 2025-11-25), négociées à l'initialisation ; une révision
  inconnue reçoit la plus récente ([tests de compatibilité](tests.md)).
* Un seul tableau `INSTRUCTIONS` pour le modèle : citer la ligne Source, interroger Sage X3 et Salesforce quand le
  système n'est pas nommé, enchaînements d'outils conseillés.

En production (`APP_ENV=production`), un connecteur sans configuration (`mock`) n'est pas exposé. Sans URL (stack de
base `docker-compose.yml`, ou variable vidée), Sage X3 et MyReport tournent en simulateur étiqueté ; la stack de
pré-production les pointe par défaut vers le bouchon `mcp-stub`.

## 4. Portail

`hub/public/index.html`, une page sans dépendance externe (CSP stricte). Depuis la 1.4.0, un écran de travail : bandeau
de situation, une ligne par application groupée par domaine (`domain` du connecteur ou `CONNECTOR_DOMAINS`), colonne
« Service », assistant à brancher en colonne de droite, exemples de questions par domaine. `GET /api/me` (version,
environnement, instance et nom du serveur, SSO, e-mail, clé, `assistantAt` = jour du dernier appel MCP avec la clé, écrit au
plus une fois par jour et effacé à la régénération de la clé, systèmes avec leur état et leur domaine) alimente les
lignes ; `GET /api/status` (`health.js`, rafraîchi chaque minute) donne l'état de chaque système, sans volume ni
identité ; `GET /metrics` (jeton `METRICS_TOKEN`) l'expose à la supervision ; `GET /api/test/:system` exécute le diagnostic ;
`POST /api/:system/apikey`, `POST /api/disconnect/:system`, `POST /api/key/rotate`, `POST /api/logout` changent l'état
du collaborateur (même origine exigée). La liste des variables affichées est dérivée de l'environnement (préfixes
`SF_`, `SAGE_`, `MS_`, …), secrets masqués.

Charte et ressources (v1.3.1) : jetons de couleur, d'espacement et de rayon dans les variables CSS en tête de
`index.html`, une variante claire et une sombre ; couleurs de la charte Clevoa (encre `#2B2540`, violet `#6B30D9`, violet
clair `#B79CF0` sur fond sombre), neutres dérivés de l'encre, couleurs d'état fonctionnelles, contrastes WCAG AA vérifiés.
Logos officiels sous `public/brand/` (SVG du kit Clevoa, versions fond clair et fond sombre), favicons à la racine de
`public/`, police Outfit (SIL OFL 1.1) réduite au jeu latin sous `public/fonts/` avec sa licence. Tout est servi par le
hub (`express.static`) : aucune ressource externe, la CSP n'a pas changé. Icônes : un sprite SVG en ligne, sans
bibliothèque. Ne pas recréer un logo à la main : reprendre les fichiers du kit officiel.

## 5. Connecteurs

Cinq modules dans `hub/connectors/`, trois familles : REST avec jeton de l'utilisateur (Sage X3, SharePoint), proxy
d'un serveur MCP distant (Salesforce, Dropbox, MyReport : `mcpclient.js` ouvre une session MCP par appel, fermée
ensuite), simulateur intégré (Sage X3 et MyReport sans URL). Interface et budget de lignes :
[écrire un connecteur](connecteurs.md).

## 6. Déploiement

`docker-compose.yml` (base commune : `mcp-hub`, `mcp-backup`, `nginx` en profil `proxy`) étendu par
`docker-compose.dev.yml` (bouchon, logs détaillés, défauts vers `mcp-stub`) et `docker-compose.prod.yml` (verrous).
Scripts d'exploitation dans `ops/` (`backup-loop.sh` dans le conteneur de sauvegarde, `backup.sh`, `restore.sh`,
`test-backup-restore.sh`, `ops/nginx/mcp.conf`). Détail : [installation](../admin/installation.md) et
[exploitation](../admin/exploitation.md).

## 7. Composants annexes

* [`clevoa-mcp-stub/`](../../clevoa-mcp-stub/README.md) : bouchon d'entreprise (~430 lignes), mires OAuth et Entra,
  serveurs MCP simulés, données fictives, deux collaborateurs aux droits différents.
* [`clevoa-backend/`](../../clevoa-backend/README.md) : AWS Lambda qui reçoit la télémétrie, une table DynamoDB (une fiche et
  un historique par installation), les incidents et leurs e-mails, un contrôle horaire des installations silencieuses
  (`serverless.yml`).
* [`clevoa-console/`](../../clevoa-console/README.md) : console de suivi de Clevoa, en lecture seule sur la table, en
  conteneur sur un NAS du réseau privé de Clevoa ; jamais installée chez un client.
* [`loadtest/`](../../loadtest/README.md) : bouchons rapides et générateur d'utilisateurs MCP pour la campagne de charge.

## 8. Règles de simplicité

Pas de framework, pas de serveur de base de données (la base d'exploitation est le SQLite intégré à Node, un fichier dans
le volume), pas de service supplémentaire, pas d'abstraction entre connecteurs tant qu'un quatrième proxy n'existe pas. Factorisation refusée quand le gain est nul. Toute correction est localisée et vient avec
un test. Les décisions prises et leurs raisons sont consignées dans [l'historique](../history/decisions.md).
