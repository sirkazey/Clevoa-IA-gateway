# Accès en ligne pour Claude (web, mobile, application de bureau)

Public : l'administrateur du hub et l'administrateur Entra ID du client. Objet : permettre aux collaborateurs d'utiliser le hub
depuis Claude **hors du réseau de l'entreprise** (téléphone, ordinateur en déplacement), sans ouvrir de port sur le pare-feu et
sans clé à copier. Statut : **expérimental**, désactivé par défaut (`CLOUDFLARE_TUNNEL=1` l'active), testé sur bouchon seulement
([état des fonctionnalités](../validation/etat-des-fonctionnalites.md)). Choix et alternatives écartées :
[étude](../etudes/connexion-un-clic.md#9-décision-du-3-novembre-2026--entra-seul-relais-oauth-du-sdk-et-cloudflare-tunnel).

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

* **Aucun serveur d'autorisation maison.** Le port 8090 publie les métadonnées OAuth exigées par Claude (PKCE S256, RFC 8414,
  RFC 9728) grâce au relais du SDK MCP officiel, puis transmet la connexion et les jetons à Entra ID. Entra authentifie
  (double authentification, accès conditionnel), délivre, renouvelle et révoque les jetons.
* **Le hub vérifie chaque jeton** : signature (clés publiées par Entra), émetteur, locataire, audience, application cliente
  (le connecteur Claude), scope délégué `mcp`, expiration.
* **Même identité que le portail.** Le collaborateur est retrouvé par son identité Entra (`oid` + locataire), comme avec le
  [SSO du portail](sso-entra.md) : il garde ses connexions (Sage X3, Salesforce, SharePoint…). Un collaborateur jamais passé
  par le portail reçoit une clé liée à son identité ; il connecte ses systèmes sur le portail interne (voir § 7).
* **Port 8090 cloisonné** : métadonnées, `/authorize`, `/token`, `/mcp`, `/health` et l'icône `/favicon.ico`. Ni portail, ni clé statique, ni SSE, ni
  supervision, ni diagnostic.
* **Portail protégé d'une erreur de routage** : avec l'accès en ligne actif, le portail (8080) refuse toute requête relayée par
  Cloudflare (403). Un nom d'hôte public saisi par erreur vers `:8080` ne publie donc pas le portail.

## 2. Prérequis

* SSO Entra du portail actif (`SSO_MODE=entra`) : même locataire, même identité ([guide](sso-entra.md)).
* Le compte Cloudflare **de Clevoa**, qui exploite le service managé, et une zone DNS gérée par Cloudflare pour le nom public
  (ex. `<client>.<domaine>`) ; un tunnel et un nom d'hôte par client. Compte à sécuriser comme une production :
  [responsabilités](../developer/architecture.md#9-service-managé--qui-exploite-quoi).
* Claude **Team** ou **Enterprise** : seul l'Owner ajoute le connecteur pour l'organisation.
* Avis du DPO : Cloudflare termine le HTTPS et **voit les échanges en clair** (questions et réponses, données métier
  comprises). Cloudflare devient sous-traitant ultérieur de Clevoa, à prévoir au contrat ; la localisation des données en UE
  est réservée à l'offre Enterprise de Cloudflare.

## 3. Entra ID : application pour Claude

Deux possibilités ; le secret de cette application est confié à Anthropic (saisi dans Claude) :

* **application dédiée** (recommandée en production) : le secret confié à Anthropic n'ouvre que le scope `mcp` ;
* **application du portail réutilisée** (choix de la pré-production Charlois le 05/11/2026) : rien à créer, mais le secret
  confié à Anthropic appartient à une application qui a aussi les droits SharePoint délégués avec consentement
  administrateur. Créer alors un **secret dédié à Claude**, révocable sans toucher à celui du hub, et `ENTRAID_CLAUDE_CLIENT_ID` =
  `MS_CLIENT_ID`.

Les étapes sont les mêmes ; seule la première change (nouvelle inscription, ou ajout de l'URI de retour à l'application
existante). Libellés du centre d'administration Entra **à vérifier**.

1. Inscriptions d'applications → Nouvelle inscription (ou l'application existante) : comptes de **cet annuaire
   uniquement**, URI de redirection *Web* `https://claude.ai/api/mcp/auth_callback`.
2. Exposer une API : URI d'ID d'application `api://<ID d'application>`, scope `mcp` (« Accéder au hub Clevoa en lecture »,
   consentement par les administrateurs et les utilisateurs).
3. Manifeste : `"requestedAccessTokenVersion": 2` (sous `api`). Sans cela, Entra émet des jetons v1 que le hub refuse.
4. Certificats et secrets : nouveau secret client ; noter sa **valeur** (pas son identifiant) et sa date d'expiration.
5. API autorisées : ajouter le scope `mcp` (onglet « Mes API », ou « API utilisées par mon organisation ») et
   `offline_access`, puis « Accorder un consentement d'administrateur ». Application réutilisée : ce consentement couvre
   aussi les droits Graph du portail, qui doivent tous être déclarés dans la liste (sinon le consentement les retire).
6. Recommandé : Applications d'entreprise → cette application → Propriétés → **Affectation requise** = Oui, puis affecter les
   collaborateurs ou un groupe. Les autres comptes de l'annuaire ne pourront pas se connecter.
7. Recommandé : une stratégie d'accès conditionnel (double authentification) ciblant cette application.

## 4. Cloudflare : tunnel et règles

Procédure complète, contrôles et rotations : [runbook Cloudflare](cloudflare.md). En bref : compte Clevoa sécurisé (§ 1),
un tunnel et un nom d'hôte par client et par environnement, à un seul niveau sous le domaine (`<client>.<domaine>`),
une seule route vers `http://mcp-hub:8090` (§ 3), chemins autorisés seulement et `/mcp` et `/token` réservés aux adresses
d'Anthropic (§ 4), contrôles après chaque modification (§ 5).

## 5. Hub : variables et démarrage

Le tunnel et le port en ligne font partie des stacks de pré-production et de production (depuis la 1.7.0-rc.2) : rien à
ajouter à la stack, seulement des variables (Portainer : *Environment variables*, puis *Update the stack*).

| Variable de la stack | Valeur |
|---|---|
| `CLOUDFLARE_TUNNEL` | `1` : démarre `cloudflared` et ouvre le port 8090 du hub ; vide ou `0` : accès en ligne désactivé |
| `CLOUDFLARE_TUNNEL_TOKEN` | le jeton du tunnel : le long texte après `--token` dans la commande Docker affichée par Cloudflare (pas l'ID du tunnel) |
| `CLOUDFLARE_PUBLIC_URL` | le nom public, sans chemin, ex. `https://<client>-test.<domaine>` |
| `ENTRAID_CLAUDE_CLIENT_ID` | l'ID d'application Entra utilisée par Claude (celle du portail si elle est réutilisée) |
| `ENTRAID_CLAUDE_CLIENT_SECRET` | la valeur du secret réservé à Claude |

Facultatives : `ENTRAID_CLAUDE_REDIRECT_URIS` (vide = `https://claude.ai/api/mcp/auth_callback`), `CLOUDFLARE_TRUST_PROXY`
(défaut 1), `CLOUDFLARE_TUNNEL_PROTOCOL` (défaut `http2`, sur TCP 443 : passe les pare-feu qui bloquent l'UDP 7844 ; `auto`
si l'UDP est ouvert). Dans le conteneur, le hub les reçoit sous les noms `ONLINE`, `ONLINE_URL`, `ONLINE_CLIENT_ID`,
`ONLINE_CLIENT_SECRET`, `ONLINE_REDIRECT_URIS` et `ONLINE_TRUST_PROXY`.

Contrôle : un conteneur `cloudflared-preprod` (ou `-prod`) en marche ; ligne de journal du hub `[online] accès en ligne actif :
https://<client>-test.<domaine>/mcp (port 8090, annuaire …)` ; le tunnel « Healthy » dans Cloudflare ; puis
`https://<client>-test.<domaine>/.well-known/oauth-authorization-server` répond depuis un navigateur. Le hub refuse de démarrer
sans SSO, sans identifiant ou secret, avec une adresse non https en production, ou avec le même port que le portail ; le
message cite l'adresse reçue (« vide » : variable absente ou mal nommée dans la stack). `cloudflared` attend que le hub soit
« healthy » (quelques secondes) ; s'il reste « created », le démarrer à la main et lire son journal.

Retour arrière : `CLOUDFLARE_TUNNEL=0` puis *Update the stack* ; le conteneur `cloudflared` disparaît, le portail interne est
inchangé. Supprimer ensuite le nom d'hôte public dans Cloudflare.

## 6. Claude : ajout du connecteur par l'Owner

Paramètres de l'organisation → Connecteurs → Ajouter un connecteur personnalisé (libellés **à vérifier**) :

* nom : `Clevoa – <client>` (ex. « Clevoa – Charlois »), affiché tel quel aux collaborateurs ;
* URL : `https://<client>.<domaine>/mcp` (exactement, chemin compris) ;
* paramètres avancés : identifiant client = `ENTRAID_CLAUDE_CLIENT_ID`, secret client = `ENTRAID_CLAUDE_CLIENT_SECRET`.

Chaque collaborateur clique ensuite **Connecter**, se connecte avec son compte Microsoft de l'entreprise, et retrouve le
connecteur dans claude.ai, l'application de bureau et l'application mobile. Le portail le guide : avec
`CLOUDFLARE_TUNNEL=1`, « Brancher votre assistant » s'ouvre sur l'onglet « Claude » (étapes et adresse `/mcp` à donner à
l'Owner) et n'affiche plus le bloc `mcp-remote` de Claude Desktop ; « Claude Code et autres » reste disponible.

Présentation : le hub annonce un titre (« Clevoa AI Gateway »), une description (systèmes proposés, lecture seule) et le logo
Clevoa (icônes intégrées, protocole MCP 2025-11-25), et chaque outil a un titre lisible (« Sage X3 – rechercher »…). Claude
affichait encore une icône générique pour les connecteurs personnalisés : le logo apparaîtra quand il sera pris en charge.

## 7. Limites connues

* **Connexion des systèmes** : Sage X3, Salesforce, SharePoint et Dropbox se connectent encore sur le **portail interne**
  (réseau de l'entreprise). Un collaborateur qui n'y est jamais passé voit, dans Claude, le message « Action requise » avec
  le lien du portail. Prochaine étape étudiée : SharePoint par le flux « On-Behalf-Of » d'Entra, sans portail.
* **Coupure d'un compte** : un compte désactivé dans Entra ne peut plus renouveler son jeton, mais garde un jeton d'accès
  valide jusqu'à son expiration (environ une heure).
* **Un seul annuaire** : le locataire du portail (`MS_TENANT_ID`). Un second locataire ou Google demanderait un serveur
  d'identité (Keycloak), voir l'étude.
* **Points à prouver au premier essai réel** : envoi du secret par Claude dans le corps de la requête (`client_secret_post`,
  seule méthode acceptée par le SDK) ; comportement d'Entra avec les scopes imposés par le hub ; connecteur sur mobile.
* Test d'intrusion externe et preuve du cloisonnement entre deux collaborateurs réels : préalables à toute production.

## 8. Premier essai : critères

| # | Vérification | Attendu |
|---|---|---|
| 1 | Métadonnées depuis un navigateur hors réseau | JSON ; `code_challenge_methods_supported` = `["S256"]` |
| 2 | `/` et `/api/me` sur le nom public | 404 |
| 3 | `POST /mcp` depuis un poste (hors adresses d'Anthropic) | refus Cloudflare (règle WAF) |
| 4 | « Connecter » dans claude.ai, compte Entra affecté | retour dans Claude, connecté |
| 5 | Même compte que sur le portail | question Sage X3 servie avec ses identifiants, sans nouvelle saisie |
| 6 | Application mobile, hors Wi-Fi de l'entreprise | connecteur présent et utilisable |
| 7 | Compte non affecté à l'application | refus par Entra |
| 8 | Compte désactivé dans Entra | plus d'accès au plus tard à l'expiration du jeton (environ une heure) |
| 9 | Deux collaborateurs | chacun ses données ; « Déconnecter » l'un ne touche pas l'autre |
| 10 | Journal du hub | aucune adresse e-mail ni jeton (`eyJ`) |
