# Accès en ligne pour Claude (web, mobile, application de bureau)

Public : l'administrateur du hub et l'administrateur Entra ID du client. Objet : permettre aux collaborateurs d'utiliser le hub
depuis Claude **hors du réseau de l'entreprise** (téléphone, ordinateur en déplacement), sans ouvrir de port sur le pare-feu et
sans clé à copier. Statut : **expérimental**, désactivé par défaut (`ONLINE=on`), testé sur bouchon seulement
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
* **Port 8090 cloisonné** : métadonnées, `/authorize`, `/token`, `/mcp` et `/health`. Ni portail, ni clé statique, ni SSE, ni
  supervision, ni diagnostic.
* **Portail protégé d'une erreur de routage** : avec l'accès en ligne actif, le portail (8080) refuse toute requête relayée par
  Cloudflare (403). Un nom d'hôte public saisi par erreur vers `:8080` ne publie donc pas le portail.

## 2. Prérequis

* SSO Entra du portail actif (`SSO_MODE=entra`) : même locataire, même identité ([guide](sso-entra.md)).
* Le compte Cloudflare **de Clevoa**, qui exploite le service managé, et une zone DNS gérée par Cloudflare pour le nom public
  (ex. `mcp.exemple.fr`) ; un tunnel et un nom d'hôte par client. Compte à sécuriser comme une production :
  [responsabilités](../developer/architecture.md#9-service-managé--qui-exploite-quoi).
* Claude **Team** ou **Enterprise** : seul l'Owner ajoute le connecteur pour l'organisation.
* Avis du DPO : Cloudflare termine le HTTPS et **voit les échanges en clair** (questions et réponses, données métier
  comprises). Cloudflare devient sous-traitant ultérieur de Clevoa, à prévoir au contrat ; la localisation des données en UE
  est réservée à l'offre Enterprise de Cloudflare.

## 3. Entra ID : inscription « connecteur Claude »

Une **inscription d'application distincte** de celle du portail et de SharePoint : son secret est confié à Anthropic (saisi dans
Claude), il doit pouvoir être révoqué seul. Libellés du centre d'administration Entra **à vérifier**.

1. Inscriptions d'applications → Nouvelle inscription : nom « Clevoa – connecteur Claude », comptes de **cet annuaire
   uniquement**, URI de redirection *Web* `https://claude.ai/api/mcp/auth_callback`.
2. Exposer une API : URI d'ID d'application `api://<ID d'application>`, scope `mcp` (« Accéder au hub Clevoa en lecture »,
   consentement par les administrateurs et les utilisateurs).
3. Manifeste : `"requestedAccessTokenVersion": 2` (sous `api`). Sans cela, Entra émet des jetons v1 que le hub refuse.
4. Certificats et secrets : nouveau secret client ; noter sa **valeur** (pas son identifiant) et sa date d'expiration.
5. Consentement administrateur pour le scope `mcp` (et `offline_access`), pour éviter l'écran de consentement à chaque
   collaborateur.
6. Recommandé : Applications d'entreprise → cette application → Propriétés → **Affectation requise** = Oui, puis affecter les
   collaborateurs ou un groupe. Les autres comptes de l'annuaire ne pourront pas se connecter.
7. Recommandé : une stratégie d'accès conditionnel (double authentification) ciblant cette application.

## 4. Cloudflare : tunnel et règles

Libellés du tableau de bord Cloudflare **à vérifier**.

1. Zero Trust → Réseaux → Tunnels → Créer un tunnel *Cloudflared* ; copier le **jeton** (variable `TUNNEL_TOKEN`, jamais
   commité, jamais dans un ticket).
2. Nom d'hôte public : `mcp.exemple.fr` → service `http://mcp-hub:8090`. Ne publier **aucun autre** service.
3. Sécurité de la zone, pour ce nom d'hôte :
   * désactiver le blocage des robots d'IA et le « Bot Fight Mode » : ils bloquent Claude ;
   * règle WAF : `/mcp` et `/token` acceptés seulement depuis les adresses d'Anthropic
     ([liste officielle](https://platform.claude.com/docs/en/api/ip-addresses), à recopier le jour de la mise en place) ;
     `/authorize` et `/.well-known/` ouverts (navigateur du collaborateur, découverte par Claude) ; tout autre chemin bloqué.
     Comparer les chemins en minuscules.

## 5. Hub : variables et démarrage

Dans `.env`, en plus de la configuration existante :

```
ONLINE_URL=https://mcp.exemple.fr
ONLINE_CLIENT_ID=<ID d'application de l'inscription « connecteur Claude »>
ONLINE_CLIENT_SECRET=<valeur du secret>
TUNNEL_TOKEN=<jeton du tunnel Cloudflare>
```

Démarrage, en ajoutant le complément `docker-compose.online.yml` à la stack existante (Portainer : *Additional paths*) :

```bash
docker compose -f docker-compose.prod.yml -f docker-compose.online.yml up -d
```

Contrôle : ligne de journal `[online] accès en ligne actif : https://mcp.exemple.fr/mcp (port 8090, annuaire …)`, puis
`https://mcp.exemple.fr/.well-known/oauth-authorization-server` répond depuis un navigateur. Le hub refuse de démarrer sans SSO,
sans identifiant ou secret, avec une adresse non https en production, ou avec le même port que le portail.

Retour arrière : relancer la stack **sans** `docker-compose.online.yml` ; le tunnel tombe, le portail interne est inchangé.
Supprimer ensuite le nom d'hôte public dans Cloudflare.

## 6. Claude : ajout du connecteur par l'Owner

Paramètres de l'organisation → Connecteurs → Ajouter un connecteur personnalisé (libellés **à vérifier**) :

* URL : `https://mcp.exemple.fr/mcp` (exactement, chemin compris) ;
* paramètres avancés : identifiant client = `ONLINE_CLIENT_ID`, secret client = `ONLINE_CLIENT_SECRET`.

Chaque collaborateur clique ensuite **Connecter**, se connecte avec son compte Microsoft de l'entreprise, et retrouve le
connecteur dans claude.ai, l'application de bureau et l'application mobile.

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
