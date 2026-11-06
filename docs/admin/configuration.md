# Configuration des connecteurs

Pour l'administrateur qui branche les systèmes de l'entreprise sur le hub, connecteur par connecteur. Statuts :
[état des fonctionnalités](../validation/etat-des-fonctionnalites.md) ; SSO du portail : [SSO Entra ID](sso-entra.md).

Sage X3 et Salesforce sont vérifiés sur les vrais systèmes, SharePoint sur un locataire réel, Dropbox sur un compte
personnel ; MyReport, testé sur bouchon seulement, a une procédure « à vérifier ».

## 0. Le fichier `.env` et les URI de rappel

La configuration tient dans `.env`, à la racine du dépôt (copie de [`.env.example`](../../.env.example), qui documente
toutes les variables ; jamais versionné). Sous Portainer : écran « Environment variables » de la stack, puis
**Update the stack**. En déploiement manuel, après chaque modification :

```bash
docker compose -f docker-compose.dev.yml up -d      # pré-production ; docker-compose.prod.yml en production
```

* `ENCRYPTION_KEY` chiffre `users.json`. La changer oblige tous les collaborateurs à se reconnecter.
* Sage X3 et MyReport sans URL fonctionnent en simulateur (données inventées et étiquetées) ; en production, ils ne
  sont pas exposés.
* Jamais de commentaire sur la même ligne qu'une valeur vide : Compose le lirait comme la valeur.
* `MCP_SERVER_NAME` (défaut `clevoa-gateway`) : nom annoncé par le serveur MCP et clé du bloc `mcpServers` copié depuis
  le portail. Le changer n'oblige personne à refaire sa configuration.
* `INSTANCE_LABEL` (vide = « Clevoa AI Gateway ») : libellé affiché sur le portail.

URI de rappel à déclarer chez chaque fournisseur (`<PUBLIC_URL>` exact, sans barre finale) :

| Système | URI de redirection | Où la déclarer |
|---|---|---|
| Salesforce | `<PUBLIC_URL>/auth/salesforce/callback` | application cliente externe (§ 2) |
| Sage X3 (OAuth, optionnel) | `<PUBLIC_URL>/auth/sagex3/callback` | IdP de Syracuse |
| SharePoint / OneDrive | `<PUBLIC_URL>/auth/sharepoint/callback` | application Entra ID (§ 3) |
| SSO Entra ID | `<PUBLIC_URL>/auth/sso/callback` et `<PUBLIC_URL>/?sso=off` | application Entra ID ([SSO](sso-entra.md)) |
| Dropbox | `<PUBLIC_URL>/auth/dropbox/callback` | App Console Dropbox (§ 4) |

## 1. Sage X3 24R1 (API REST Syracuse)

Le hub lit l'API REST Syracuse (GET uniquement) avec l'identité de chaque collaborateur. Mode vérifié :
`SAGE_APIKEY_MODE=basic` (identifiant et mot de passe Syracuse saisis sur le portail). Non vérifiés : OAuth2
(variables `SAGE_OAUTH_*`) et clé d'API en `bearer`.

### Ce qu'il faut

| Information | Où la trouver | Exemple |
|---|---|---|
| URL Syracuse | barre d'adresse de Sage X3, racine du site | `https://x3-test-ext-<client>.4cadcloud2.com` |
| Point de connexion | bandeau du haut → clic sur le nom du dossier → « Points de connexion », colonne **Nom** (pas l'intitulé) | `<POINT_DE_CONNEXION>` |
| Compte Syracuse | celui du collaborateur, **rattaché à ce point de connexion** avec un utilisateur X3 | |

Le rôle administrateur Syracuse n'est pas nécessaire : l'API applique les droits fonctionnels de l'utilisateur X3.

### Étape 1 : vérifier l'accès depuis un poste

PowerShell (le mot de passe est demandé à l'invite) :

```
curl.exe -sS -u IDENTIFIANT -w "`nHTTP %{http_code}`n" "https://<syracuse>/api1/x3/erp/<POINT_DE_CONNEXION>/`$prototypes('BPCUSTOMER.`$query')"
```

* `HTTP 200`, JSON commençant par `{"$actxUser":…` : étape 2.
* `Utilisateur ou mot de passe incorrect` : vérifier la fiche utilisateur Syracuse (méthode « basic »).
* `No X3 user matching in this endpoint` : faire rattacher le compte au point de connexion par l'intégrateur.
* `HTTP 404 … representation does not exist`, ou `HTTP 500 Unexpected token <` au premier appel : représentation non
  publiée, ticket intégrateur.

### Étape 2 : `.env`

```
SAGE_URL=https://<syracuse>
SAGE_FOLDER=<POINT_DE_CONNEXION>
SAGE_APIKEY_MODE=basic
SAGE_REPRESENTATIONS=BPCUSTOMER,BPSUPPLIER,PINVOICE,SORDER,PORDER,ITMMASTER
```

* `SAGE_REPRESENTATIONS` vide prend ces six représentations. Ajouter `SINVOICE` ou `GACCENTRY` seulement une fois
  publiées par l'intégrateur.
* `SAGE_LANG` (défaut `fr-FR`) ne change que les titres de champs. Délai par requête : 30 s, fixe.
* Pré-production : garder les lignes `SAGE_OAUTH_*` présentes et vides ([installation § 4](installation.md#4-déploiement-avec-portainer-gitops)).

### Étape 3 : connexion et diagnostic sur le portail

1. Ligne **Sage X3** → **Saisir mes identifiants** → identifiant et mot de passe Syracuse → **Vérifier et enregistrer**.
2. Le hub les essaie auprès de Syracuse. Refusés (`Sage X3 a refusé cet identifiant ou ce mot de passe (401)`) ou
   Syracuse injoignable : rien n'est enregistré.
3. Le bouton de test de la ligne donne le détail :
   * `Connecté à … par identifiant et mot de passe Syracuse · 6 représentations` : OK ;
   * `absentes de ce dossier (404) : …` : non publiées, ticket intégrateur ; le reste fonctionne ;
   * `interdites à votre utilisateur X3 (403) : …` : droits fonctionnels X3 du collaborateur ;
   * `en erreur côté Sage (5xx, à signaler à l'intégrateur) : …`.
4. Erreur 401 plus tard : mot de passe changé ou compte désactivé, ressaisir sur le portail.

**Syracuse bloque le compte après quelques mots de passe erronés.** Le hub n'envoie qu'un essai par vérification, au
plus deux par quart d'heure, et efface des identifiants refusés au lieu de les réessayer.

### Comportements vérifiés

* La structure (`$prototypes`) est gardée en mémoire par utilisateur jusqu'à 03:00.
* `sagex3_query` ne renvoie que les **colonnes de liste**. Le filtre `where` accepte tout champ d'en-tête (ex.
  `AMTATI gt 400`) sans en renvoyer la valeur ; `sagex3_get` lit la fiche (paramètre `champs` pour filtrer).
* Dates : `@AAAA-MM-JJ@` ; le hub convertit une date entre apostrophes.
* PINVOICE : le type de pièce se lit dans `PIHTYP` (1 facture, 2 facture complémentaire, 3 avoir, 4 avoir/retour)
  quand l'intégrateur l'a publié, sinon dans le numéro (`…FAF…` / `…AVF…`). Montants non signés ; statut de
  règlement absent tant que `GACCDUDATE` n'est pas publiée. Le modèle en est averti.

Nom d'une représentation : lire l'URL de l'écran (`…$sessions?f=GESPIH…`). GESPIH → `PINVOICE`, GESSIH → `SINVOICE`,
GESGAS → `GACCENTRY`, GESBPC → `BPCUSTOMER`, GESBPS → `BPSUPPLIER`, GESSOH → `SORDER`, GESPOH → `PORDER`. Représentations
spécifiques (préfixes Y, Z) : Développement → Données et paramètres → Classes → Représentations (rôle admin).

## 2. Salesforce (serveur MCP hébergé « SObject Reads »)

Le hub est client du serveur MCP Salesforce `SObject Reads` (lecture seule) avec le jeton OAuth de chaque
collaborateur : Salesforce applique profil, partage et sécurité des champs. Outils : `salesforce_tools` (six outils,
dont `soqlQuery`) et `salesforce_call`. Un `soqlQuery` sans `LIMIT` reçoit `LIMIT 200` (`SF_DEFAULT_LIMIT`), sauf les
agrégats. Un refresh token révoqué impose une reconnexion. Le hub refuse de démarrer si `SF_MCP_URL` ne se termine pas
par `/sobject-reads`.

### Ce qu'il faut

| Information | Où la trouver |
|---|---|
| URL My Domain | barre d'adresse : `https://<org>.my.salesforce.com` ou `https://<org>--<sandbox>.sandbox.my.salesforce.com` |
| URL du serveur MCP | Configuration → « Serveurs MCP » (API Catalog) → **SObject Reads**, activé → copier l'URL |
| Clé et secret consommateur | application cliente externe (étape 1) |

### Étape 1 : créer l'application cliente externe (une par org)

Droit requis : Configuration → « Gestionnaire des applications clientes externes ». Ne pas modifier les applications
de l'intégrateur.

1. **Nouvelle application cliente externe** : nom (ex. « MCP Finance »), **e-mail de contact** (il recevra le code de
   vérification), distribution : Local.
2. **API (Activer les paramètres OAuth)** → cocher **Activer OAuth**.
3. **URL de rappel** : `<PUBLIC_URL>/auth/salesforce/callback`.
4. **Étendues OAuth**, exactement deux : « Accéder aux serveurs MCP hébergés par Salesforce (mcp_api) » et « Exécuter
   des requêtes à tout moment (refresh_token, offline_access) ». Pas `api` : les jetons seraient refusés.
5. **Flux Enablement** : tout décoché.
6. **Sécurité** : cocher **Émettre des jetons d'accès basés sur JSON Web Token (JWT) pour des utilisateurs nommés**,
   **Demander un secret pour le Flux serveur Web** et **Demander un secret pour le Flux jeton d'actualisation**.
7. **Créer**, puis **Paramètres** → Paramètres OAuth → **Clé et secret du consommateur** : saisir le code reçu par
   e-mail, copier la clé et le secret.

Propagation : jusqu'à 30 minutes. Après une modification de l'application, chaque collaborateur se reconnecte.

### Étape 2 : `.env`

```
SF_LOGIN_URL=https://<org>--<sandbox>.sandbox.my.salesforce.com
SF_MCP_URL=https://api.salesforce.com/platform/mcp/v1/d/<org>--<sandbox>/sandbox/platform/sobject-reads
SF_CLIENT_ID=<clé consommateur>
SF_CLIENT_SECRET=<secret consommateur>
```

Optionnel : `SF_DEFAULT_LIMIT` (défaut 200), `SF_MAX_PER_MIN` (plafond d'appels par minute, tous collaborateurs ;
défaut illimité ; utile en production, facturée en crédits Flex).

### Étape 3 : connexion sur le portail

Carte **Salesforce** → **Se connecter** → autorisation → retour au portail. **Tester** : six outils et l'e-mail du
collaborateur.

`redirect_uri_mismatch` ou `invalid_client_id` juste après la création : propagation, attendre. `JWT Token is
required` ou 401 sur chaque appel : case JWT (étape 1.6) non cochée.

### Passage en production

Refaire les étapes dans l'org de production : nouvelle application, `SF_LOGIN_URL` = My Domain de production,
`SF_MCP_URL` de la forme `…/d/<org>/platform/sobject-reads`, `SF_MAX_PER_MIN` fixé. Dans « Serveurs MCP », laisser
**SObject Reads** seul actif, après accord de l'intégrateur Salesforce.

## 3. SharePoint / OneDrive (Microsoft Graph) — vérifié en pré-production (un compte)

Application Entra ID à **permissions déléguées** : Graph répond avec les droits du collaborateur (dossier invisible
pour lui = 403). Outils : `sharepoint_sites`, `sharepoint_list`, `sharepoint_search`, `sharepoint_read`.

* `sharepoint_search` sans `site` : Microsoft Search (`POST /search/query`, une recherche sans écriture), sur tous les
  sites et le OneDrive que le collaborateur peut ouvrir, 25 résultats avec leur `driveId`. Avec `site` : ce site seul.
* `sharepoint_read` (avec le `driveId` d'un résultat) lit Word, Excel, PowerPoint, PDF et les fichiers texte ; les
  pages d'un PDF scanné sont jointes en image ([lecture des documents](#lecture-des-documents)). Vérifié en réel le
  06/11/2026 sur un texte et un PDF scanné (journal L3) ; Word, Excel et PowerPoint vérifiés par Dropbox (G4).

Création (libellés Entra **à vérifier**) :

1. Portail Entra → Identité → Applications → Inscriptions d'applications → **Nouvelle inscription** : nom, comptes de
   cet annuaire uniquement, plateforme Web, URI `<PUBLIC_URL>/auth/sharepoint/callback`.
2. Certificats et secrets → nouveau secret client (valeur visible une seule fois).
3. API autorisées → Microsoft Graph → permissions déléguées `openid profile offline_access User.Read Files.Read.All
   Sites.Read.All` → **Accorder le consentement d'administrateur**.

La même application sert au [SSO Entra ID](sso-entra.md) (qui demande en plus `email`).

```
MS_TENANT_ID=<ID de l'annuaire (locataire)>
MS_CLIENT_ID=<ID d'application (client)>
MS_CLIENT_SECRET=<secret client>
SP_SITE=<hôte>.sharepoint.com:/sites/<site>
```

`SP_SITE` vide = OneDrive de l'utilisateur. Pré-production : `MS_LOGIN_URL` et `GRAPH_URL` réels
([installation § 4](installation.md#4-déploiement-avec-portainer-gitops)). Portail → Se connecter → Tester : `GET /me`
sur Graph, vert avec votre identité.

## 4. Dropbox — vérifié sur un compte personnel (06/11/2026)

Le hub utilise le jeton OAuth du collaborateur ; Dropbox applique ses droits. Outils :

* `dropbox_tools` et `dropbox_call` : serveur MCP officiel `https://mcp.dropbox.com/mcp`, liste blanche en lecture
  (`who_am_i`, `list_folder`, `search`, `get_file_metadata`, `list_shared_links`, `get_shared_link_metadata`). Les
  outils d'écriture sont refusés avant tout appel.
* `dropbox_read` : lecture d'un fichier par son id ou son chemin, via l'API Dropbox (`files/get_metadata`, puis
  `files/download` sur `https://content.dropboxapi.com`). Le serveur MCP officiel n'expose ni `fetch` ni
  `file_preview` à une application tierce. Formats : [lecture des documents](#lecture-des-documents).

Création de l'application (vérifiée le 06/11/2026 sur un compte personnel) :

1. https://www.dropbox.com/developers/apps → Create app → « Scoped access », « Full Dropbox », nom.
2. Onglet Permissions : `account_info.read`, `files.metadata.read`, `files.content.read`, `sharing.read`, et rien
   d'autre. **Aucune autorisation d'équipe** (`team_*`, `members.*`) : elles donnent accès aux fichiers de tous les
   membres. OpenID est inutile.
3. Onglet Settings → OAuth 2 :
   * Redirect URIs : `<PUBLIC_URL>/auth/dropbox/callback` ;
   * « Autoriser les clients publics » : **à activer**. Le hub envoie PKCE et Dropbox le refuse sinon
     (« PKCE disallowed for this app »). Risque faible : l'adresse de retour est fixée.
   * Ne pas utiliser « Générer un jeton d'accès » : chaque collaborateur se connecte depuis le portail.
4. Relever App key et App secret ; `.env` : `DROPBOX_APP_KEY`, `DROPBOX_APP_SECRET`.
5. Portail → Se connecter → Tester : la liste des outils s'affiche.

Une application « en développement » n'accepte que son créateur. Pour les autres collaborateurs : « Activer des utilisateurs
supplémentaires », ou « Demander à passer en production » (démarche **à vérifier**). En production, l'application est créée par
l'administrateur de l'équipe Dropbox Business du client.

Pré-production : renseigner les URL réelles `DROPBOX_AUTH_URL`, `DROPBOX_API_URL`, `DROPBOX_MCP_URL` et
`DROPBOX_CONTENT_URL` ([installation § 4](installation.md#4-déploiement-avec-portainer-gitops)) ; vides, elles
pointent vers le bouchon.

### Lecture des documents

`sharepoint_read` et `dropbox_read` renvoient le texte des documents, sans fichier temporaire :

| Format | Rendu |
|---|---|
| Word (`.docx`) | paragraphes ; tableaux à une ligne par rangée, cellules séparées par des tabulations |
| Excel (`.xlsx`) | une section par feuille ; une ligne par rangée ; valeur calculée des formules ; dates (jj/mm/aaaa) et pourcentages selon le format de la cellule, montants sans séparateur ni devise |
| PowerPoint (`.pptx`) | une section par diapositive, avec les notes de l'orateur |
| PDF avec texte | texte page par page (« --- Page 3 --- »), 300 pages et 20 s au plus |
| PDF scanné | pages jointes en image à Claude, 5 par demande (argument `pages`, ex. `6-10`) ; ChatGPT ne les exploite pas |
| Texte (`txt`, `csv`, `json`, `md`, `xml`…) | contenu UTF-8 |

Le hub ne fait pas de reconnaissance de caractères : Claude lit l'image lui-même, la qualité dépend du scan et chaque
page compte dans l'usage Claude. Les images (`png`, `jpg`), les anciens formats (`doc`, `xls`) et les PDF protégés par
mot de passe ne sont pas lus : le résultat donne les métadonnées et le lien. Limites : fichier de 25 Mo, 60 Mo une
fois décompressé, 200 000 caractères de texte, 4 Mo d'images par réponse.

## 5. MyReport (proxy MCP SSE) — serveur éditeur non livré

Le hub est client MCP SSE du serveur MCP de MyReport Server (`MYREPORT_MCP_URL`), annoncé par l'éditeur mais non livré :
testé sur bouchon seulement.

* Chaque collaborateur saisit **son** jeton MyReport sur le portail (`Authorization: Bearer <jeton>`, ou l'en-tête
  `MYREPORT_AUTH_HEADER`).
* Outils : `myreport_tools` et `myreport_call`.
* `MYREPORT_TOOLS` : liste blanche lecture seule, à composer d'après « Tester » ; vide = aucun transfert.
* `MYREPORT_MAX_PER_MIN` (défaut 20) plafonne les appels, tous collaborateurs : à 50 collaborateurs, c'est la première
  limite atteinte ([campagne de charge](../validation/charge-v1.2.1.md)).
* `MYREPORT_MCP_URL` vide = simulateur local (deux outils fictifs, réponses `simule: true`).

## 6. Télémétrie Clevoa

`CLEVOA_KEY` (obligatoire en production) et `CLEVOA_URL` (figée sur `https://clevoa.fr` en production). Contenu et
vérification : [sécurité § 4](securite.md#4-télémétrie-clevoa).

## 7. État des systèmes, classement et supervision

| Variable | Rôle |
|---|---|
| `PROBE` | vide : requête `HEAD` sans identifiant vers chaque système réel toutes les 10 minutes, du lundi au vendredi de 7 h à 19 h (heure `TZ`) ; `off` (`false`, `0`) : jamais ; `always` : à toute heure |
| `SLOW_MS` | p95 (ms, appels réussis de la dernière heure) au-delà duquel le portail affiche « Lent » ; défaut 10000 |
| `CONNECTORS_ENABLED` | connecteurs proposés, ex. `sagex3,salesforce,sharepoint` (`salesforce`, `sagex3`, `sharepoint`, `dropbox`, `myreport`) ; vide = tous. Un connecteur écarté disparaît partout, ses connexions restent dans `users.json`. Nom inconnu = arrêt au démarrage |
| `CONNECTOR_DOMAINS` | classement sur le portail, ex. `sagex3=industrie,myreport=finance` (`commerce`, `finance`, `industrie`, `documents`, `rh`, `autre`) ; défaut : Salesforce en Commerce, Sage X3 et MyReport en Finance, SharePoint et Dropbox en Documents |
| `METRICS_TOKEN` | jeton de `GET /metrics` et `GET /metrics/prtg`, 24 caractères au moins (sinon le hub refuse de démarrer) ; vide = routes désactivées ([exploitation § 11](exploitation.md#11-supervision-du-hub)) |

Prévenir l'équipe réseau : ces requêtes `HEAD` régulières vers les adresses configurées peuvent alerter un pare-feu ou un WAF.

## 8. Base d'exploitation et journal d'audit

Le hub tient une base SQLite dans son volume, `/data/hub.db` : disponibilité de chaque système (une mesure toutes les
10 minutes, 90 jours), appels et collaborateurs actifs par mois (24 mois), journal d'audit s'il est activé. Exploitation : [§ 12](exploitation.md#12-disponibilité-usage-et-journal-daudit) ;
données personnelles : [sécurité § 7](securite.md#7-base-dexploitation-et-journal-daudit).

| Variable | Rôle |
|---|---|
| `AUDIT` | `on` (`true`, `1`, `oui`) : chaque appel d'outil est journalisé (date, collaborateur, système, outil, résultat, durée ; jamais les arguments ni les données) ; vide (défaut) : pas de journal. À activer seulement après avis du DPO et information des collaborateurs |
| `AUDIT_DAYS` | conservation en jours, entier ≥ 1 (sinon, audit actif, le hub refuse de démarrer) ; défaut 90. Purge quotidienne ; les sauvegardes `hub-*.db` gardent les lignes `BACKUP_KEEP_DAYS` jours de plus |

Audit actif : la ligne de démarrage se termine par `· journal d'audit 90 j`. Base illisible ou disque plein : les
outils continuent, sans historique, compteurs ni audit, et le journal l'écrit (`[db] base d'exploitation indisponible`).
