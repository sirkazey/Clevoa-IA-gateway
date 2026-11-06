# Accès en ligne pour Claude (web, mobile, application de bureau)

Public : l'administrateur du hub et l'administrateur Entra ID du client. Objet : utiliser le hub depuis Claude **hors du
réseau de l'entreprise**, sans port entrant ni clé à copier.

Statut : **expérimental**, désactivé par défaut (`CLOUDFLARE_TUNNEL=1` l'active), testé sur bouchon seulement
([état des fonctionnalités](../validation/etat-des-fonctionnalites.md)). Choix et alternatives :
[étude](../history/etude-connexion-un-clic.md#9-décision-du-3-novembre-2026--entra-seul-relais-oauth-du-sdk-et-cloudflare-tunnel).

## 1. Principe

```
 Claude (cloud d'Anthropic)          Navigateur du collaborateur (connexion, une fois)
            │ HTTPS                              │ HTTPS
            ▼                                    ▼
 ┌──────── Cloudflare : nom public ONLINE_URL, règles WAF ────────┐
 └───────────────────────────────┬────────────────────────────────┘
                                 │ tunnel SORTANT (cloudflared → Cloudflare)
 ┌──────── serveur du hub : aucun port entrant ───────────────────┐
 │ cloudflared ──► mcp-hub:8090  OAuth relayé vers Entra + /mcp   │
 │                 mcp-hub:8080  portail (réseau interne, inchangé)│
 └────────────────────────────────────────────────────────────────┘
                                 │ connexion et jetons
                                 ▼
                     Microsoft Entra ID (locataire du client)
```

* Pas de serveur d'autorisation maison : le relais OAuth du SDK MCP officiel (PKCE S256, RFC 8414, RFC 9728) renvoie vers
  Entra ID, qui authentifie (double authentification, accès conditionnel) et délivre les jetons.
* Le hub vérifie chaque jeton : signature, émetteur, locataire, audience, application cliente, scope `mcp`, expiration.
* Même identité que le [SSO du portail](sso-entra.md) (`oid` + locataire) : le collaborateur garde ses connexions.
* Le port 8090 n'expose que les métadonnées, `/authorize`, `/token`, `/mcp`, `/health`, `/favicon.ico` et `/icon.png`.
* Le portail (8080) refuse toute requête relayée par Cloudflare (403).

## 2. Prérequis

* SSO du portail actif (`SSO_MODE=entra`), même locataire ([SSO](sso-entra.md)).
* Le compte Cloudflare de Clevoa, un tunnel et un nom d'hôte par client ([cloudflare.md](cloudflare.md)).
* Claude **Team** ou **Enterprise** : seul l'Owner ajoute le connecteur.
* Avis du DPO : Cloudflare termine le HTTPS et **voit les échanges en clair**, données métier comprises. Il devient
  sous-traitant ultérieur de Clevoa (à prévoir au contrat) ; la localisation en UE exige l'offre Enterprise de Cloudflare.

## 3. Entra ID : application pour Claude

Le secret de cette application est confié à Anthropic (saisi dans Claude). En production, préférer une **application
dédiée** : son secret n'ouvre que le scope `mcp`. Si l'application du portail est réutilisée, lui créer un **secret
réservé à Claude** et poser `ENTRAID_CLAUDE_CLIENT_ID` = `MS_CLIENT_ID`. Libellés Entra **à vérifier**.

1. Inscriptions d'applications → Nouvelle inscription (ou l'application existante) : comptes de **cet annuaire
   uniquement**, URI de redirection *Web* `https://claude.ai/api/mcp/auth_callback`.
2. Exposer une API : URI `api://<ID d'application>`, scope `mcp` (consentement par les administrateurs et les utilisateurs).
3. Manifeste : `"requestedAccessTokenVersion": 2` (sous `api`). Sinon Entra émet des jetons v1, que le hub refuse.
4. Certificats et secrets : nouveau secret ; noter sa **valeur** (pas son identifiant) et son expiration.
5. API autorisées : ajouter `mcp` (onglet « Mes API ») et `offline_access`, puis « Accorder un consentement
   d'administrateur ». Application réutilisée : tous les droits Graph du portail doivent rester déclarés, sinon le
   consentement les retire.
6. Recommandé : Applications d'entreprise → l'application → Propriétés → **Affectation requise** = Oui, puis affecter les
   collaborateurs ou un groupe.
7. Recommandé : une stratégie d'accès conditionnel (double authentification) sur cette application.
8. Facultatif : revendication `given_name` sur le jeton d'accès ([SSO](sso-entra.md#mode-entra--ce-quil-faut-dans-entra-id)).

## 4. Cloudflare : tunnel et règles

Voir le [runbook Cloudflare](cloudflare.md) : nom `<client>.<domaine>`, route unique vers `http://mcp-hub:8090`, WAF.

## 5. Hub : variables et démarrage

Le tunnel fait partie des stacks : poser les variables (Portainer : *Environment variables*, puis *Update the stack*).
Modèle : `.env.example`.

| Variable | Valeur |
|---|---|
| `CLOUDFLARE_TUNNEL` | `1` : démarre `cloudflared` et ouvre le port 8090 ; vide ou `0` : désactivé |
| `CLOUDFLARE_TUNNEL_TOKEN` | jeton du tunnel : le texte après `--token` dans la commande Docker affichée par Cloudflare (pas l'ID du tunnel) |
| `CLOUDFLARE_PUBLIC_URL` | nom public sans chemin, ex. `https://<client>-test.<domaine>` |
| `ENTRAID_CLAUDE_CLIENT_ID` | ID de l'application Entra utilisée par Claude |
| `ENTRAID_CLAUDE_CLIENT_SECRET` | valeur du secret réservé à Claude |
| `ENTRAID_CLAUDE_REDIRECT_URIS` | facultatif ; vide = `https://claude.ai/api/mcp/auth_callback` |
| `CLOUDFLARE_TRUST_PROXY` | facultatif ; défaut `1` |
| `CLOUDFLARE_TUNNEL_PROTOCOL` | facultatif ; défaut `http2` (TCP 443, passe les pare-feu qui bloquent l'UDP 7844) ; `auto` si l'UDP est ouvert |

Dans le conteneur, le hub les lit sous les noms `ONLINE`, `ONLINE_URL`, `ONLINE_CLIENT_ID`, `ONLINE_CLIENT_SECRET`,
`ONLINE_REDIRECT_URIS` et `ONLINE_TRUST_PROXY`.

**Contrôle** :

1. Le conteneur `cloudflared-preprod` (ou `cloudflared-prod`) tourne.
2. Le journal du hub contient `[online] accès en ligne actif : https://<client>-test.<domaine>/mcp (port 8090, annuaire …)`.
3. Le tunnel est « Healthy » dans Cloudflare.
4. `https://<client>-test.<domaine>/.well-known/oauth-authorization-server` répond dans un navigateur.

**Refus de démarrer** : sans SSO, sans identifiant ou secret, avec une adresse non https en production, ou sur le port
du portail. Le message cite l'adresse reçue (« vide » : variable absente ou mal nommée). `cloudflared` resté
« created » : le démarrer à la main et lire son journal.

**Retour arrière** : `CLOUDFLARE_TUNNEL=0`, puis *Update the stack*. Le conteneur `cloudflared` disparaît, le portail
interne ne change pas. Supprimer ensuite le nom d'hôte public dans Cloudflare.

## 6. Claude : ajout du connecteur par l'Owner

Vérifié le 06/11/2026 sur Claude Team, en connecteur personnel. Trois rôles, une seule saisie technique :

| Qui | Quoi | Quand |
|---|---|---|
| Administrateur Entra | application de `ENTRAID_CLAUDE_CLIENT_ID` → Propriétés → **Affectation requise : Oui**, puis affecter les testeurs ou les groupes autorisés (libellés **à vérifier**) | avant tout ajout dans l'organisation : sinon tout membre peut se connecter |
| Owner Claude | Paramètres de l'organisation → Connecteurs → Ajouter un connecteur personnalisé | une fois par environnement |
| Collaborateur | Paramètres → Connecteurs → **Connecter** → compte Microsoft | une fois |

Saisie de l'Owner (formulaire « Ajouter un connecteur personnalisé ») :

* nom : `Clevoa – <client> (test)` en pré-production, `Clevoa – <client>` en production : les deux peuvent coexister ;
* URL : `https://<client>.<domaine>/mcp` (chemin compris) ;
* authentification : « Se connecter maintenant » (détecté) ; client OAuth : « Utiliser votre propre client OAuth » (détecté),
  identifiant = `ENTRAID_CLAUDE_CLIENT_ID`, secret = `ENTRAID_CLAUDE_CLIENT_SECRET` (**obligatoire**, bien que Claude
  l'indique facultatif) ; aucun en-tête.

Pour un essai, l'ajouter d'abord dans ses propres connecteurs (Personnalisation → Connecteurs) : personne d'autre ne le
voit. Le connecteur suit ensuite le collaborateur sur le web, le bureau et le mobile ; Claude range les outils en
« lecture seule » et demande une approbation à chaque appel, réglable par l'utilisateur. Sur le portail, « Brancher votre assistant » s'ouvre alors sur l'onglet « Claude » ; l'onglet « Claude
Desktop » (`mcp-remote`) disparaît et la clé reste dans l'onglet « Clé personnelle » ([guide](../user/guide-utilisateur.md)).

Le hub annonce un titre (« Clevoa AI Gateway »), une description qui donne l'adresse du portail (où le collaborateur
connecte ses applications), ce portail comme site (`websiteUrl`) et le logo Clevoa, intégré et par adresse https
(`/icon.png`). Vérifié le 06/11/2026 (1.7.0-rc.8) : pour un connecteur personnalisé, Claude n'affiche que le nom saisi
et l'URL, avec une icône générique ; ni logo, ni description, ni site. Les titres des 14 outils, eux, s'affichent.

### ChatGPT (vérifié le 06/11/2026, compte personnel Plus)

Même hub, même application Entra, même secret. Avant tout usage sur des données réelles : accord de la DSI et du DPO du
client, et un abonnement ChatGPT d'entreprise (les données lues partent chez OpenAI).

1. ChatGPT (web) → Plugins → **Ajouter** → **Ajouter un serveur MCP personnalisé** : nom `Clevoa – <client> (test)`,
   description, icône (`https://<hote>/icon.png`), connexion « URL du serveur » `https://<hote>/mcp`, authentification
   OAuth.
2. **Paramètres OAuth avancés** : identifiants saisis (ni DCR, ni CIMD) ; identifiant = `ENTRAID_CLAUDE_CLIENT_ID`,
   secret = `ENTRAID_CLAUDE_CLIENT_SECRET` copié depuis la stack (un secret mal recopié est refusé : journal
   `[online] /token refusé (400) : invalid_client`) ; méthode `client_secret_post` (`client_secret_basic` accepté depuis
   la 1.7.0-rc.9) ; portée par défaut `mcp` ; OIDC désactivé.
3. Relever l'**URL de rappel** affichée (`https://chatgpt.com/connector/oauth/<id>`, stable pour un même compte) et
   l'ajouter, avec `https://chatgpt.com/connector_platform_oauth_redirect`, dans Entra (plateforme Web) et dans
   `ENTRAID_CLAUDE_REDIRECT_URIS`, à la suite de celle de Claude ; redéployer.
4. Cloudflare : liste IP `openai_chatgpt` (plages de `https://openai.com/chatgpt-connectors.json`) ajoutée à la règle 2,
   et règle 1 ouverte à tout `/.well-known/` ([runbook § 4](cloudflare.md#4-règles-de-sécurité-du-nom-dhôte)).
5. **Connecter** → compte Microsoft.

ChatGPT affiche le nom, la description et l'icône saisis. Constaté : Word, Excel et PowerPoint lus ; pages d'un PDF scanné
non exploitées (Claude les lit).

## 7. Limites connues

* **Connexion des systèmes** : Sage X3, Salesforce, SharePoint et Dropbox se connectent sur le **portail interne**. Un
  collaborateur jamais passé par le portail reçoit dans Claude « Action requise » avec le lien du portail. Piste étudiée, non
  inscrite à la roadmap : SharePoint par le flux « On-Behalf-Of » d'Entra.
* **Compte désactivé dans Entra** : accès conservé jusqu'à l'expiration du jeton (environ une heure).
* **Un seul annuaire** : celui du portail (`MS_TENANT_ID`).
* **À prouver au premier essai réel** : envoi du secret par Claude en `client_secret_post` (seule méthode du SDK) ;
  comportement d'Entra avec les scopes imposés par le hub ; connecteur sur mobile.
* Test d'intrusion externe et cloisonnement entre deux collaborateurs réels : préalables à toute production.

## 8. Premier essai : critères

Faire d'abord les contrôles du [runbook Cloudflare § 5](cloudflare.md#5-contrôles-après-chaque-mise-en-place-ou-modification).

| # | Vérification | Attendu |
|---|---|---|
| 1 | « Connecter » dans claude.ai, compte affecté | connecté |
| 2 | Question Sage X3, même compte que sur le portail | servie sans nouvelle saisie |
| 3 | Application mobile, hors réseau de l'entreprise | connecteur utilisable |
| 4 | Compte non affecté à l'application | refus par Entra |
| 5 | Compte désactivé dans Entra | plus d'accès après environ une heure |
| 6 | Deux collaborateurs | chacun ses données ; « Déconnecter » l'un ne touche pas l'autre |
| 7 | Journal du hub | aucune adresse e-mail ni jeton (`eyJ`) |

## 9. Inscription automatique (CIMD), 1.8, expérimental

Objet : ajouter le connecteur dans Claude ou ChatGPT avec **son URL seule**, sans saisir d'identifiant ni de secret.
Statut : **expérimental**, désactivé par défaut, testé sur bouchon seulement (`hub/test/online-cimd.test.js`).

### Principe

L'assistant se présente par l'adresse https d'un document qu'il publie (CIMD : *Client ID Metadata Document*,
[spécification MCP 2025-11-25](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization#client-id-metadata-documents)).
Le hub :

1. n'accepte que les adresses de sa **liste blanche** (`ENTRAID_CIMD_CLIENTS`), comparées à l'identique ;
2. récupère le document en https seulement : sans redirection, en 5 s et 5 Ko au plus, jamais vers une adresse IP privée
   ou de boucle locale ; le garde en cache selon `Cache-Control` (une heure au plus), jamais en cas d'erreur ;
3. retient les adresses de retour présentes **à la fois** dans le document et dans la liste connue du hub (celle de
   l'assistant, intégrée, ou `ENTRAID_CLAUDE_REDIRECT_URIS`) ;
4. traite l'assistant en **client public** : aucun secret, PKCE S256 obligatoire ;
5. reçoit lui-même la réponse d'Entra sur `https://<hote>/oauth/callback`, puis renvoie à l'assistant **son propre
   code** : à usage unique, valable 5 minutes, lié à l'assistant, à son adresse de retour, au PKCE et au navigateur qui a
   commencé la connexion (témoin `HttpOnly`) ;
6. échange ensuite ce code auprès d'Entra avec **son** inscription et **son** secret. Les jetons restent ceux d'Entra ;
   le hub n'en délivre aucun.

Le client préenregistré (identifiant et secret saisis) reste accepté. Quand CIMD est actif, il passe lui aussi par
`/oauth/callback`.

### Assistants reconnus

`ENTRAID_CIMD_CLIENTS=on` admet les deux documents ci-dessous, relevés le 06/11/2026 :

| Assistant | Document (`client_id`) | Adresse de retour admise | Source |
|---|---|---|---|
| Claude (web, bureau, mobile, Cowork) | `https://claude.ai/oauth/mcp-oauth-client-metadata` | `https://claude.ai/api/mcp/auth_callback` | document lu le 06/11/2026 ; adresse non citée par la [documentation d'Anthropic](https://claude.com/docs/connectors/building/authentication) : **à vérifier** au premier essai |
| ChatGPT | `https://chatgpt.com/oauth/client.json` | `https://chatgpt.com/connector_platform_oauth_redirect` | [documentation d'OpenAI](https://developers.openai.com/plugins/build/auth) et document lu le 06/11/2026 |

Claude Code (`https://claude.ai/oauth/claude-code-client-metadata`) est exclu : son adresse de retour est une boucle
locale (`http://localhost/callback`), que tout programme du poste peut usurper.

### Mise en place

1. Entra ID, application de `ENTRAID_CLAUDE_CLIENT_ID` → Authentification → plateforme *Web* : ajouter l'URI de
   redirection `https://<hote>/oauth/callback` (libellés **à vérifier**). Les adresses de Claude et de ChatGPT peuvent
   rester ; elles ne servent plus.
2. Cloudflare, [règle 1](cloudflare.md#4-règles-de-sécurité-du-nom-dhôte) : ajouter `"/oauth/callback"` à la liste des
   chemins autorisés. Ne **pas** l'ajouter à la règle 2 : c'est le navigateur du collaborateur qui l'appelle, comme
   `/authorize`.
3. Stack : `ENTRAID_CIMD_CLIENTS=on`, puis *Update the stack*. Le journal contient `[online] inscription automatique
   (CIMD, expérimental) : …` et l'adresse de retour à enregistrer.
4. Contrôle : `curl -s https://<hote>/.well-known/oauth-authorization-server` contient
   `"client_id_metadata_document_supported":true`.
5. Claude : « Ajouter un connecteur personnalisé », URL seule, sans identifiant ni secret (option « Utiliser l'identité
   publiée de Claude »). ChatGPT : connexion OAuth, option CIMD.

| Variable | Valeur |
|---|---|
| `ENTRAID_CIMD_CLIENTS` | vide ou `0` : désactivé (comportement 1.7) ; `on` : Claude et ChatGPT ; sinon les adresses https des documents, séparées par des virgules |

Dans le conteneur, le hub la lit sous le nom `ONLINE_CIMD_CLIENTS`. `ONLINE_CIMD_ALLOW_LOOPBACK=1` (documents en `http`
sur `127.0.0.1`) ne sert qu'aux tests ; le hub refuse de démarrer avec en production.

**Retour arrière** : `ENTRAID_CIMD_CLIENTS=` puis *Update the stack*. Les connecteurs ajoutés par URL seule ne se
connectent plus ; ceux qui ont un identifiant et un secret continuent, à condition que l'adresse de retour de
l'assistant soit restée dans Entra.

### Sécurité : ce qui change

* Plus aucun secret chez Anthropic ni chez OpenAI ; le secret Entra reste dans la stack.
* Mêmes barrières qu'avant : liste blanche des assistants, adresses de retour vérifiées, PKCE, comptes du locataire
  seulement, affectation et accès conditionnel d'Entra, vérification de chaque jeton par le hub.
* Nouveau : le hub délivre des **codes** (pas des jetons) et appelle les adresses de la liste blanche.
* Risque résiduel : un jeton de renouvellement Entra volé suffit, sans secret, pour obtenir un jeton d'accès. Avant la
  1.8, il fallait aussi le secret, mais celui-ci était détenu par les mêmes assistants.
* Autorisations en cours et codes sont en mémoire : un redémarrage du hub oblige à relancer la connexion.

### À vérifier au premier essai réel

1. Claude choisit bien CIMD avec ce document, sans identifiant saisi.
2. ChatGPT utilise le document stable `client.json` (le hub annonce le paramètre `iss`, RFC 9207). À défaut, il présente
   un document par compte (`https://chatgpt.com/oauth/<id>/client.json`), que la liste blanche refuse.
3. Entra accepte l'échange avec l'adresse `/oauth/callback` et le défi PKCE de l'assistant.
4. Journal : aucun code, jeton ni secret ; refus lisibles (`[online] document CIMD refusé (…)`).
