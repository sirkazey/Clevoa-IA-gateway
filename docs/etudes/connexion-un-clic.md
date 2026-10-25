# Étude : connexion de l'assistant en un clic (OAuth, Cloudflare, multi-clients)

Étude du 25 octobre 2026, **avant tout développement**. Elle répond à une question de la direction de Clevoa : comment
un collaborateur peut-il brancher le hub dans Claude Desktop (et Claude web, mobile, ChatGPT, Microsoft Copilot) en un
clic, sans Node.js, sans mode développeur ni bloc de configuration à copier, pour plusieurs clients et pour des
collaborateurs qui ne sont pas tous dans le même annuaire.

**Contraintes fixées par la DSI de Charlois (25/10/2026)** : le « Connect » dans Claude est autorisé ; **aucun port
ne doit être ouvert sur un pare-feu** (aucun flux entrant). Les collaborateurs relèvent de trois annuaires : Entra de
Charlois, Entra d'Oakwood Cooperage (autre tenant), Google de la société en cours d'acquisition. La direction de
Clevoa ne veut pas dépendre d'un tiers sans nécessité.

Chaque affirmation porte sa source (documentation officielle, consultée le 25/10/2026) ou sa preuve (essai exécuté).
Ce qui n'est pas prouvé est marqué **à prouver**. Rien n'est décidé tant que le prototype du § 7 n'a pas réussi.

## 1. Réponse courte

1. **Le « un clic » existe, mais seulement avec OAuth.** Dans Claude Team, l'administrateur ajoute le connecteur une
   fois pour l'organisation ; chaque membre le voit et clique « Connect » ([S1], [S2]). Les connecteurs distants
   n'acceptent que « sans authentification » ou OAuth ; une clé dans un en-tête n'est réservée qu'à quelques
   organisations en bêta et désigne l'organisation, pas la personne ([S4]).
2. **Le hub doit être joignable depuis internet**, car Claude appelle le serveur depuis le cloud d'Anthropic, même
   depuis Claude Desktop ([S1]). Les « MCP tunnels » d'Anthropic, qui l'évitent, sont réservés à Claude Enterprise
   ([S8]) ; Charlois est en Team. ChatGPT et Copilot appellent aussi depuis leur cloud ([C1], [O2]).
3. **Le hub devient son propre serveur d'autorisation OAuth**, avec les briques du SDK MCP qu'il utilise déjà. C'est la
   seule voie qui marche pour Claude, ChatGPT et Copilot à la fois (§ 3). Preuve locale réussie (§ 6).
4. **L'identité est gérée par le hub lui-même**, sans intermédiaire : il parle directement, en OIDC, à chaque
   annuaire (Entra de Charlois, Entra d'Oakwood Cooperage, Google de la société acquise) et propose sa propre page
   « Se connecter avec… ». Il le fait déjà pour un annuaire Entra (`hub/sso.js`). Pas de coût par utilisateur, pas de
   tiers qui voit qui se connecte.
5. **Aucun port ouvert : un tunnel sortant.** Le hub (un conteneur à côté de lui) ouvre une connexion sortante vers
   un relais joignable depuis internet ; Claude appelle le relais. Deux relais possibles, le hub restant neutre (§ 4) :
   Cloudflare Tunnel (gratuit, rien à exploiter, mais Cloudflare voit les données en clair) ou un relais open source
   hébergé par Clevoa (indépendance et chiffrement de bout en bout, mais un service à exploiter).
6. **Pas d'usine à gaz** : un serveur OAuth dans le hub (briques du SDK), une page de choix d'annuaire, un conteneur
   de tunnel. Ni Cloudflare Access, ni Worker, ni portail MCP, ni proxy par application.

## 2. Ce que les assistants exigent (documenté)

| Exigence | Claude (Team) | ChatGPT | Microsoft Copilot |
|---|---|---|---|
| Ajout pour toute l'organisation | oui, par l'Owner ; chaque membre clique « Connect » [S1] [S2] | espace Business ou Enterprise : l'administrateur publie l'application [O1] | connecteur fédéré Microsoft 365 (licence Microsoft 365 Copilot) ou agent Copilot Studio [C2] [C3] |
| Méthode | OAuth : client enregistré automatiquement (DCR), document CIMD, ou client fourni par l'administrateur [S2] [S4] | OAuth ; refuse un serveur sans `code_challenge_methods_supported` [O1] | OAuth « dynamique » (DCR) ou « manuel » (identifiant, secret, URL) [C2] |
| Appels depuis | `160.79.104.0/21`, IPv4 seulement, DNS public [S5] [S7] | liste `chatgpt-connectors.json` [O2] | cloud Power Platform (étiquettes `AzureConnectors`) [C4] |
| Spécification | autorisation MCP 2025-03-26 à 2025-11-25 ; PKCE S256, paramètre `resource`, métadonnées RFC 9728 avec `401` [S3] [S4] [S5] | idem | idem |
| Adresse de retour OAuth | `https://claude.ai/api/mcp/auth_callback` [S4] | `https://chatgpt.com/connector/oauth/*` [O1] | fournie par l'assistant Copilot Studio ; `teams.microsoft.com/api/platform/v1.0/oAuthRedirect` pour Microsoft 365 [C2] |
| Limites | 240 s par appel d'outil, ~150 000 caractères de résultat [S3] | — | Streamable HTTP seulement, outils et ressources [C2] |

Révision courante de la spécification d'autorisation MCP : 2026-07-28 ([M1]) ; l'enregistrement dynamique (DCR) y est
déprécié au profit des documents CIMD, que Claude et ChatGPT savent utiliser ([S4], [O1]).

## 3. Pourquoi le hub doit être son propre serveur d'autorisation

| Option | Verdict | Raison |
|---|---|---|
| Entra ID directement serveur d'autorisation | **écartée** | ni DCR ni CIMD ([C5]) ; métadonnées sans `code_challenge_methods_supported` (vérifié par `curl` le 25/10, `/.well-known/oauth-authorization-server` en 404), donc refusé par ChatGPT ([O1]) ; un seul annuaire, alors que Charlois en a trois |
| Cloudflare Access « Managed OAuth » | **écartée pour l'instant** | bêta ouverte ([CF2]) ; échec signalé de claude.ai web et mobile contre la même URL qui marche avec Claude Code, ticket fermé sans correctif ([CF6]) |
| Worker Cloudflare `workers-oauth-provider` | **réserve** | conforme et cite ChatGPT ([CF4]) ; mais un composant de plus, des ressources figées dans le code (une par client) et un relais à monter vers chaque tunnel ([CF4]) : c'est l'usine à gaz à éviter |
| **Le hub, serveur d'autorisation** (SDK MCP : `mcpAuthRouter`, `requireBearerAuth`) | **retenue** | le hub publie PKCE S256, DCR (et CIMD à ajouter), émet ses propres jetons courts pour sa seule adresse, révoque quand il veut ; il délègue la connexion à un fournisseur d'identité ; les jetons Salesforce, Sage… restent séparés (pas de « token passthrough », interdit par la spécification [M1]) ; flux prouvé en local (§ 6) |

## 4. Architecture proposée

```
 Claude (cloud Anthropic)      ChatGPT (cloud OpenAI)      Copilot (cloud Microsoft)
            \                          |                           /
             \__________ HTTPS  charlois-mcp.<domaine Clevoa> ____/
                                       |
                    RELAIS (au choix, § 4.1) : Cloudflare Tunnel ou relais open source Clevoa
                    seules routes publiées : /mcp, /authorize, /token, /register, /.well-known/*
                    /mcp limité aux adresses des trois éditeurs ; portail du hub non publié
                                       ▲
                     connexion SORTANTE initiée depuis le réseau de Charlois
 ======================================|========== pare-feu de Charlois : aucun port entrant ==
                         [conteneur tunnel]  à côté du hub
                                       |
                    [Hub MCP] serveur d'autorisation OAuth + serveur MCP
                     |   page « Se connecter avec… » ──► Entra Charlois │ Entra Oakwood │ Google
                     ├─► Sage X3, MyReport (réseau interne, inchangé)
                     └─► Salesforce, SharePoint, Dropbox (inchangé, jetons de chaque collaborateur)
```

**Parcours d'un collaborateur** : dans Claude, « Connect » → page du hub « Se connecter avec Microsoft (Charlois),
Microsoft (Oakwood Cooperage) ou Google » → connexion habituelle de son entreprise (double authentification comprise),
souvent sans saisie s'il est déjà connecté → retour dans Claude, connecté. Le hub le reconnaît par l'identifiant que
lui donne son annuaire ; s'il manque une application (Salesforce, par exemple), la réponse de l'outil lui donne le lien
pour la connecter une fois.

**Ce que fait le hub** : serveur d'autorisation OAuth pour les assistants (jetons d'accès de 15 minutes,
renouvellement avec rotation et, à chaque renouvellement, vérification auprès de l'annuaire que le compte est toujours
actif) ; client OIDC de chaque annuaire configuré ; serveur MCP inchangé ; les clés actuelles restent pour Claude Code
et les scripts.

### 4.1 Le relais : deux options, le hub ne dépend d'aucune

| | Cloudflare Tunnel (`cloudflared`) | Relais open source hébergé par Clevoa (frp ou rathole) |
|---|---|---|
| Port entrant chez le client | aucun ([CF1]) | aucun |
| Coût | gratuit, jusqu'à 1 000 tunnels ([CF1]) ; domaine géré dans Cloudflare | un petit serveur en France (quelques euros par mois) |
| Exploitation | aucune : Cloudflare l'exploite | Clevoa : disponibilité, mises à jour de sécurité, supervision, sauvegarde |
| Données | Cloudflare termine HTTPS sur son réseau : il voit les requêtes et réponses MCP en clair | en tunnel TCP pur, HTTPS va jusqu'au hub : le relais ne voit que des octets chiffrés (**à prouver** selon l'outil) |
| Protection devant le hub | réseau Cloudflare (attaques par saturation, pare-feu) | celle du serveur relais, à construire |
| Dépendance | un tiers de plus | aucun tiers en plus ; un service de plus pour Clevoa |
| Licence | service propriétaire, logiciel `cloudflared` open source | frp : Apache 2.0 ; rathole : à vérifier dans son dépôt |

Recommandation : **prototyper avec les deux**, puis choisir sur pièces. Le choix n'engage pas le produit : le hub n'a
besoin que d'une adresse publique, et changer de relais se fait sans toucher à son code. Un client peut aussi fournir
son propre relais.

**Multi-clients** : par client, un conteneur de tunnel à côté de son hub et un nom d'hôte (`<client>-mcp.<domaine>`),
la même image du hub, les annuaires de ce client dans sa configuration.

## 5. Coûts et limites (documentés)

| Élément | Coût ou limite | Source |
|---|---|---|
| Identité (OIDC direct vers Entra et Google) | aucun coût par utilisateur ; une inscription d'application par annuaire (Entra Charlois, Entra Oakwood, Google) | — |
| Cloudflare Tunnel (option) | gratuit, 1 000 tunnels par compte | [CF1] |
| Relais open source (option) | coût du serveur ; temps d'exploitation de Clevoa | — |
| Délai d'une requête à travers Cloudflare | 125 s ; le hub coupe déjà Sage X3 à 30 s | [CF9], `hub/connectors/sagex3.js` |
| Délai d'un appel d'outil côté Claude | 240 s | [S3] |
| Nom d'hôte | un seul niveau sous la zone pour rester couvert par le certificat standard | à vérifier à la création |

Cloudflare Access (page de choix d'annuaire hébergée par Cloudflare) n'est plus nécessaire : gratuit jusqu'à
50 utilisateurs au total, tous clients confondus, puis 7 $ par utilisateur et par mois ([CF7]) ; écarté au profit de la
page du hub.

## 6. Ce qui est prouvé, ce qui reste à prouver

| Point | État |
|---|---|
| Flux OAuth complet avec le SDK MCP 1.32.1 du hub : métadonnées RFC 9728 et RFC 8414, `401` avec `WWW-Authenticate`, DCR, PKCE S256 (mauvais vérificateur refusé), paramètre `resource` et refus d'un jeton d'une autre audience, appel d'outil avec le jeton, renouvellement avec rotation (ancien jeton refusé), révocation immédiate | **prouvé en local** (HTTP, sans vraie connexion d'utilisateur, stockage en mémoire) |
| Métadonnées publiques d'Entra (absence de PKCE annoncé, de DCR, de RFC 8414) | **prouvé** (`curl`, 25/10/2026) |
| Exigences de Claude, adresses d'Anthropic, connecteur d'organisation Team | **documenté** [S1]–[S8] |
| Tunnel sortant sans port entrant (Cloudflare) | **documenté** [CF1] |
| Parcours réel : Claude Team → relais → hub → page de choix → annuaire → retour dans Claude | **à prouver** (§ 7) |
| Connexion de deux tenants Entra (Charlois, Oakwood) et de Google sur le même hub | **à prouver** ; une inscription d'application par annuaire |
| Relais open source en TCP pur (chiffrement jusqu'au hub) | **à prouver** |
| ChatGPT et Copilot Studio contre le serveur d'autorisation du hub | **à prouver** (documenté côté éditeurs) |
| SharePoint pour Oakwood Cooperage (autre tenant) : application Entra multi-tenant consentie par Oakwood ; aujourd'hui un seul tenant et un site par défaut (`MS_TENANT_ID`, `SP_SITE`) | **à étudier** ; les utilisateurs Google n'ont pas de SharePoint (un connecteur Google Drive serait un autre sujet) |

## 7. Prototype avant de développer

Un prototype jetable, sur la préproduction et un nom d'hôte de test, sans toucher au code de production :

1. Hub de préproduction avec un serveur d'autorisation minimal (briques du SDK, jetons en mémoire) et une page de
   choix d'annuaire (un Entra et un Google de test).
2. Relais n° 1 : `cloudflared` à côté du hub. Relais n° 2 : frp ou rathole vers un petit serveur de Clevoa.
3. Connecteur ajouté dans un compte Claude de Clevoa (un connecteur personnalisé est possible dès l'offre gratuite
   [S1]), puis dans l'organisation Team de Charlois par son Owner.

**Critère de réussite** : un collaborateur de test clique « Connect » dans Claude Desktop, choisit son annuaire,
revient connecté, interroge Sage X3 de préproduction, sans rien installer ni copier, et **sans aucun port entrant
ouvert** ; la désactivation de son compte dans l'annuaire coupe l'assistant en moins de 15 minutes. Puis le même essai
avec ChatGPT (si un espace Business est disponible) et Copilot Studio.

Éléments à fournir par Clevoa pour le prototype : un nom de domaine de test ; un compte Cloudflare (relais n° 1) et un
petit serveur (relais n° 2) ; une inscription d'application dans un Entra de test et un client OAuth Google de test.

## 8. Ce que cela remet en cause

* Décisions d'octobre 2026 : pas de serveur OAuth dans le hub ; claude.ai web et mobile non pris en charge ; hub non
  exposé à internet. À remplacer par une décision datée **après** le prototype.
* Contrat et DPO : Anthropic (ou OpenAI, Microsoft) détient des jetons d'accès au hub de chaque collaborateur. Avec
  Cloudflare Tunnel, Cloudflare termine le chiffrement HTTPS sur son réseau : il voit en clair les requêtes et réponses
  MCP (données métier comprises), donc sous-traitant à inscrire au registre et au contrat ; avec un relais open source
  en TCP pur, le relais ne voit que des données chiffrées.
* Sécurité : aucun port entrant chez le client, mais le hub devient atteignable via le relais sur ses seules routes MCP
  et OAuth ; le portail reste interne.
  Une revue de sécurité indépendante est un préalable à la production.

## Sources

* [S1] Anthropic, custom connectors (remote MCP) : https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp
* [S2] Claude, ajouter un connecteur non répertorié : https://claude.com/docs/connectors/custom/add-unlisted
* [S3] Claude, construire un connecteur (spécifications, limites) : https://claude.com/docs/connectors/building
* [S4] Claude, authentification : https://claude.com/docs/connectors/building/authentication
* [S5] Claude, dépannage (paramètre `resource`, DNS, Entra) : https://claude.com/docs/connectors/building/troubleshooting
* [S7] Anthropic, adresses IP : https://platform.claude.com/docs/en/api/ip-addresses
* [S8] Claude, MCP tunnels (Enterprise) : https://claude.com/docs/connectors/mcp-tunnels/overview
* [O1] OpenAI, authentification des applications : https://developers.openai.com/apps-sdk/build/auth
* [O2] OpenAI, adresses IP : https://developers.openai.com/api/docs/guides/ip-addresses
* [C1] Microsoft, appels sortants Power Platform : https://learn.microsoft.com/connectors/common/outbound-ip-addresses
* [C2] Microsoft, MCP dans Copilot Studio : https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent
* [C3] Microsoft, connecteurs fédérés Microsoft 365 Copilot : https://learn.microsoft.com/microsoft-365/copilot/connectors/set-up-custom-federated-connectors
* [C4] Microsoft, MCP et connecteurs Power Platform : https://learn.microsoft.com/microsoft-copilot-studio/mcp-add-existing-server-to-agent
* [C5] Microsoft, pas de DCR avec Entra : https://learn.microsoft.com/microsoft-365/copilot/extensibility/plugin-authentication-dynamic-client-registration
* [M1] Spécification d'autorisation MCP 2026-07-28 : https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
* [CF1] Cloudflare, Tunnels for Platforms : https://developers.cloudflare.com/tunnel/features/tunnels-for-platforms/
* [R1] frp (licence Apache 2.0) : https://github.com/fatedier/frp
* [CF2] Cloudflare, Managed OAuth : https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
* [CF3] Cloudflare, fournisseurs d'identité et code par e-mail : https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/ et https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
* [CF4] Cloudflare, workers-oauth-provider : https://github.com/cloudflare/workers-oauth-provider
* [CF5] Cloudflare, jeton d'application et règles d'accès : https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ et https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
* [CF6] Ticket public (non officiel) claude.ai contre Cloudflare Managed OAuth : https://github.com/anthropics/claude-ai-mcp/issues/410
* [CF7] Cloudflare Zero Trust, offres et sièges : https://www.cloudflare.com/plans/sase-zero-trust/ et https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/
* [CF8] Cloudflare, limites de compte et page de connexion : https://developers.cloudflare.com/cloudflare-one/account-limits/
* [CF9] Cloudflare, délais de connexion : https://developers.cloudflare.com/fundamentals/reference/connection-limits/
