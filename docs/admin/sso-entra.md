# SSO Microsoft Entra ID (portail)

Public : l'administrateur du hub et l'administrateur Entra ID du client. Objet : identifier les collaborateurs sur le
portail par leur compte Microsoft (`SSO_MODE=entra`), et basculer une instance existante.

## Ce que fait le SSO

* Le visiteur est envoyé vers Entra ID ; avec une session Microsoft 365 dans le navigateur, il revient sans rien saisir.
* Sa clé MCP est **liée à son identité Entra** (`oid` + locataire) : il la retrouve depuis n'importe quel navigateur ; aucune
  autre identité ne peut l'obtenir par le portail. La clé reste un secret porteur : qui la détient l'utilise.
* Les clients MCP ne changent pas (`Authorization: Bearer <clé>`).
* Le SSO **authentifie** seulement : scopes `openid profile email`, aucun jeton Microsoft conservé. SharePoint garde son
  consentement propre, tenté sans interaction juste après le SSO, puis par « Se connecter » si Entra refuse. Le hub
  n'accepte que des jetons Graph du **même compte** que l'identité du portail.
* Sans `SSO_MODE`, le portail crée une clé au premier passage dans le navigateur.

Statut : vérifié avec le compte du propriétaire et une collaboratrice non administratrice, chacun avec ses propres
connexions ([journal C1–C3](../validation/journal-tests-reels.md)).

## Mode `entra` : ce qu'il faut dans Entra ID

Une seule application Entra sert SharePoint et le SSO ([configuration § 3](configuration.md#3-sharepoint--onedrive-microsoft-graph--vérifié-en-pré-production-un-compte)).
Libellés du portail Entra **à vérifier**. Le code impose seulement les URI de redirection, le GUID du locataire et les scopes.

| Dans Entra (Inscriptions d'applications → l'application) | Valeur |
|---|---|
| Vue d'ensemble → ID d'application (client) | `MS_CLIENT_ID` |
| Vue d'ensemble → ID de l'annuaire (locataire) | `MS_TENANT_ID` (un GUID ; `common` est refusé) |
| Types de comptes pris en charge | Comptes de cet annuaire d'organisation uniquement |
| Authentification → URI de redirection (Web), une seule liste | `<PUBLIC_URL>/auth/sso/callback`, `<PUBLIC_URL>/auth/sharepoint/callback` et `<PUBLIC_URL>/?sso=off` (retour après « Se déconnecter »), sans barre finale ; laisser vide « URL de déconnexion du canal frontal » |
| Certificats et secrets | le secret déjà utilisé pour SharePoint (`MS_CLIENT_SECRET`) |
| Configuration du jeton → revendication facultative, type **ID** → `given_name` | facultatif : le portail affiche le prénom, sinon le nom complet (`name`). Pour l'application de l'accès en ligne, même réglage sur le jeton **d'accès** |
| API autorisées (Microsoft Graph, déléguées) | `openid`, `profile`, `email`, `offline_access`, `User.Read`, `Files.Read.All`, `Sites.Read.All`, toutes déclarées, avec **consentement administrateur** (sinon SharePoint redemande une connexion après le SSO) |

`.env` (en production, `PUBLIC_URL` en https) :

```
SSO_MODE=entra
MS_TENANT_ID=<GUID de l'annuaire>
MS_CLIENT_ID=<ID d'application (client)>
MS_CLIENT_SECRET=<secret client>
```

Le hub refuse de démarrer si `MS_TENANT_ID` n'est pas un GUID, si l'application manque, ou si `MS_LOGIN_URL` ne désigne
pas `login.microsoftonline.com`. Ne jamais poser `NODE_TLS_REJECT_UNAUTHORIZED=0`.

**Contrôle** : la ligne de démarrage contient `· SSO entra` ; le portail affiche le prénom (ou le nom) avec « via
Microsoft Entra ID ».

**Échecs** :

| Symptôme | Cause |
|---|---|
| « Échec de la connexion Microsoft Entra ID (…) », HTTP 400 | `id_token` refusé : locataire ou application inattendus |
| Même message, HTTP 502, journal `[oauth] sso : échec de l'échange de jeton (HTTP 400)` | Entra refuse l'échange du code : secret ou URI faux |
| Codes du journal `SSO_REVENDICATIONS_ABSENTES`, `SSO_LOCATAIRE`, `SSO_AUDIENCE`, `SSO_EXPIRE` | `id_token` incomplet, d'un autre locataire, d'une autre application, ou expiré |
| `SSO_AUTRE_COMPTE` | SharePoint connecté avec un autre compte Microsoft que celui du portail |
| « Système inconnu ou session absente » | flux lancé sans identité |

## Mode `mock` : développement et CI, jamais la production

`SSO_MODE=mock` avec le bouchon (`docker-compose.dev.yml`) : le conteneur `mcp-stub` simule Entra (mire à deux comptes
fictifs, `id_token`, PKCE, `prompt=none`, déconnexion) ; le code du hub est le même. Le hub refuse `mock` si
`APP_ENV=production` ou si `MS_LOGIN_URL` pointe vers Microsoft. Tests : `hub/test/sso.test.js`,
`clevoa-mcp-stub/test/stub.test.js`.

## Ce que le SSO ne fait pas

* **« Se déconnecter » ferme aussi la session Microsoft du navigateur** (protection des postes partagés) : les autres
  onglets Microsoft 365 sont déconnectés.
* **Un compte désactivé dans Entra garde sa clé MCP** jusqu'à sa régénération ; seuls ses jetons Graph cessent de se
  renouveler. Départ d'un collaborateur : [exploitation § 8](exploitation.md#8-départ-dun-collaborateur-clé-compromise).
* **Les clés créées sans SSO sont invalidées** à l'activation (voir la bascule).
* Tout compte du locataire peut obtenir une clé. Les droits sur les données restent ceux de chaque système.

## Bascule d'une instance existante vers le SSO

Une clé créée avant le SSO n'est jamais reprise. Tant que l'assistant la garde, tous ses appels sont refusés avec un
message générique (« The connector returned an error »).

1. Prévenir les collaborateurs : leurs assistants cesseront de répondre jusqu'à l'étape 3.
2. Poser `SSO_MODE=entra`, redéployer, constater `· SSO entra` sur la ligne de démarrage.
3. Chaque collaborateur ouvre le portail, reconnecte ses systèmes, copie sa **nouvelle** clé (« Brancher mon
   assistant ») dans son assistant et le redémarre complètement.
4. Suivre le journal : `[mcp] clé refusée (401) : N appels depuis <adresse>` signale un assistant resté sur une ancienne clé.
