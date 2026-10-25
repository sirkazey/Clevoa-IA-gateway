# Étude : connexion de l'assistant en un clic (OAuth, Cloudflare, multi-clients)

Étude du 25 octobre 2026, **avant tout développement**. Elle répond à une question de la direction de Clevoa : comment
un collaborateur peut-il brancher le hub dans Claude Desktop (et Claude web, mobile, ChatGPT, Microsoft Copilot) en un
clic, sans Node.js, sans mode développeur ni bloc de configuration à copier, pour plusieurs clients et pour des
collaborateurs qui ne sont pas tous dans le même annuaire.

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
4. **Cloudflare porte l'exposition et l'identité, pas l'OAuth** : un tunnel sortant (aucun port ouvert chez le client)
   et Cloudflare Access comme fournisseur d'identité unique du hub, qui propose au collaborateur le bon annuaire :
   Entra de Charlois, Entra d'Oakwood Cooperage, Google de la société acquise, ou un code par e-mail. Le « Managed
   OAuth » de Cloudflare, qui ferait d'Access le serveur d'autorisation, est écarté : bêta, et échec signalé avec
   claude.ai ([CF6]).
5. **Pas d'usine à gaz** : par client, un conteneur `cloudflared` à côté du hub, une application Access, des règles de
   pare-feu Cloudflare. Pas de Worker, pas de portail MCP, pas de VPC, pas de proxy par application.

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
             \_________ HTTPS  charlois-mcp.clevoa.fr ____________/
                                       |
                     Cloudflare (compte Clevoa, zone clevoa.fr)
                     - règle pare-feu : /mcp réservé aux adresses des trois éditeurs
                     - /authorize, /token, /register, /.well-known/* : ouverts (navigateur et éditeurs)
                     - portail du hub (/, /api/*) : non publié
                                       |
                        tunnel sortant (port 7844), aucun port entrant chez Charlois
 ======================================|====================== réseau de Charlois ======
                              [cloudflared]  conteneur à côté du hub
                                       |
                          [Hub MCP]  serveur d'autorisation OAuth + serveur MCP
                          |        \
                          |         \__ connexion du collaborateur (OIDC) ──► Cloudflare Access
                          |                                                    page de choix :
                          |                                                    · Microsoft (Charlois)
                          |                                                    · Microsoft (Oakwood Cooperage)
                          |                                                    · Google (société acquise)
                          |                                                    · code par e-mail (secours)
                          ├─► Sage X3, MyReport (réseau interne, inchangé)
                          └─► Salesforce, SharePoint, Dropbox (inchangé, jetons de chaque collaborateur)
```

**Parcours d'un collaborateur** : dans Claude, « Connect » → page Cloudflare « Se connecter avec… » (son annuaire) →
s'il n'est pas déjà connecté, connexion habituelle (Microsoft ou Google, avec la double authentification de son
entreprise) → retour dans Claude, connecté. Le hub le reconnaît par son adresse e-mail, vérifiée par son fournisseur
([CF5]) ; s'il manque une application (Salesforce, par exemple), la réponse de l'outil lui donne le lien pour la
connecter une fois.

**Ce que fait Cloudflare Access, et seulement ça** : une application « Access for SaaS » en OIDC par client, avec
plusieurs fournisseurs d'identité et une page de choix ([CF3]), et une règle d'accès par domaines d'e-mail :
`@charlois.com`, le domaine d'Oakwood Cooperage, celui de la société acquise ([CF5]). Pas de compte local à mot de
passe chez Cloudflare : le « compte local » est un code à usage unique envoyé par e-mail, valable 10 minutes, envoyé
seulement à une adresse autorisée ([CF3]). Il ne vaut que la boîte mail du collaborateur (facteur unique) : à réserver
au secours.

**Ce que fait le hub** : serveur d'autorisation (jetons d'accès de 15 minutes, renouvellement avec rotation, à chaque
renouvellement vérification que le collaborateur est toujours autorisé chez Access) ; serveur MCP inchangé ; les clés
actuelles restent pour Claude Code et les scripts.

**Multi-clients** : un compte Cloudflare Clevoa ; par client, un tunnel, une application Access, ses fournisseurs
d'identité et sa règle de domaines ; le tout scriptable (API ou Terraform) ([CF1]). Même image du hub pour tous.

## 5. Coûts et limites (documentés)

| Élément | Coût ou limite | Source |
|---|---|---|
| Tunnels | 1 000 gratuits par compte | [CF1] |
| Cloudflare Zero Trust (Access) | gratuit jusqu'à **50 utilisateurs au total**, puis 7 $ par utilisateur et par mois ; chaque personne qui se connecte consomme un siège, **tous clients confondus** dans le compte Clevoa | [CF7] |
| Fournisseurs d'identité | 50 par compte (un par annuaire Entra, un par Google Workspace) | [CF8] |
| Page de connexion Access | une seule par compte : pas aux couleurs de chaque client | [CF8] |
| Délai d'une requête à travers Cloudflare | 125 s ; le hub coupe déjà Sage X3 à 30 s | [CF9], `hub/connectors/sagex3.js` |
| Nom d'hôte | un seul niveau sous la zone (`charlois-mcp.clevoa.fr`) pour rester couvert par le certificat standard | à vérifier à la création |

## 6. Ce qui est prouvé, ce qui reste à prouver

| Point | État |
|---|---|
| Flux OAuth complet avec le SDK MCP 1.32.1 du hub : métadonnées RFC 9728 et RFC 8414, `401` avec `WWW-Authenticate`, DCR, PKCE S256 (mauvais vérificateur refusé), paramètre `resource` et refus d'un jeton d'une autre audience, appel d'outil avec le jeton, renouvellement avec rotation (ancien jeton refusé), révocation immédiate | **prouvé en local** (HTTP, sans vraie connexion d'utilisateur, stockage en mémoire) |
| Métadonnées publiques d'Entra (absence de PKCE annoncé, de DCR, de RFC 8414) | **prouvé** (`curl`, 25/10/2026) |
| Exigences de Claude, adresses d'Anthropic, connecteur d'organisation Team | **documenté** [S1]–[S8] |
| Plusieurs fournisseurs d'identité par application Access, page de choix, code par e-mail, règle par domaines | **documenté** [CF3] [CF5] |
| Parcours réel : Claude Team → hub derrière un tunnel → page Access → retour dans Claude | **à prouver** (§ 7) |
| La page de choix Access s'affiche bien dans la fenêtre de connexion ouverte par Claude | **à prouver** |
| ChatGPT et Copilot Studio contre le serveur d'autorisation du hub | **à prouver** (documenté côté éditeurs) |
| SharePoint pour Oakwood Cooperage (autre tenant) : l'application Entra du hub doit être multi-tenant et consentie par Oakwood ; aujourd'hui un seul tenant et un site par défaut (`MS_TENANT_ID`, `SP_SITE`) | **à étudier** ; les utilisateurs Google n'ont pas de SharePoint (un connecteur Google Drive serait un autre sujet) |

## 7. Prototype avant de développer

Un prototype jetable, sur la préproduction et un nom d'hôte de test, sans toucher au code de production :

1. Hub de préproduction avec un serveur d'autorisation minimal (briques du SDK, jetons en mémoire).
2. `cloudflared` à côté, dans le compte Cloudflare de Clevoa ; application Access for SaaS avec deux fournisseurs :
   Google et code par e-mail (puis un Entra de test).
3. Connecteur ajouté dans un compte Claude de Clevoa (un connecteur personnalisé est possible dès l'offre gratuite
   [S1]), puis dans l'organisation Team de Charlois par son Owner.

**Critère de réussite** : un collaborateur de test clique « Connect » dans Claude Desktop, choisit son annuaire, revient
connecté, interroge Sage X3 de préproduction, sans rien installer ni copier ; la désactivation de son accès chez
Access coupe l'assistant en moins de 15 minutes. Puis le même essai avec ChatGPT (si un espace Business est disponible)
et Copilot Studio.

Si le prototype échoue sur la page Access dans Claude, repli : le hub délègue directement à chaque annuaire (Entra
Charlois, Entra Oakwood, Google) avec sa propre page de choix, sans Cloudflare Access ; Cloudflare ne sert alors que de
tunnel.

## 8. Ce que cela remet en cause

* Décisions d'octobre 2026 : pas de serveur OAuth dans le hub ; claude.ai web et mobile non pris en charge ; hub non
  exposé à internet. À remplacer par une décision datée **après** le prototype.
* Contrat et DPO : Anthropic (ou OpenAI, Microsoft) détient des jetons d'accès au hub de chaque collaborateur ;
  Cloudflare termine le chiffrement HTTPS sur son réseau avant de réacheminer par le tunnel : il voit donc en clair
  les requêtes et réponses MCP (données métier comprises) et les connexions des collaborateurs. À inscrire au registre
  des traitements de Charlois et au contrat (sous-traitant).
* Sécurité : le hub devient joignable depuis internet sur ses seules routes MCP et OAuth ; le portail reste interne.
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
* [CF2] Cloudflare, Managed OAuth : https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/
* [CF3] Cloudflare, fournisseurs d'identité et code par e-mail : https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/ et https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/
* [CF4] Cloudflare, workers-oauth-provider : https://github.com/cloudflare/workers-oauth-provider
* [CF5] Cloudflare, jeton d'application et règles d'accès : https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/ et https://developers.cloudflare.com/cloudflare-one/access-controls/policies/
* [CF6] Ticket public (non officiel) claude.ai contre Cloudflare Managed OAuth : https://github.com/anthropics/claude-ai-mcp/issues/410
* [CF7] Cloudflare Zero Trust, offres et sièges : https://www.cloudflare.com/plans/sase-zero-trust/ et https://developers.cloudflare.com/cloudflare-one/team-and-resources/users/seat-management/
* [CF8] Cloudflare, limites de compte et page de connexion : https://developers.cloudflare.com/cloudflare-one/account-limits/
* [CF9] Cloudflare, délais de connexion : https://developers.cloudflare.com/fundamentals/reference/connection-limits/
