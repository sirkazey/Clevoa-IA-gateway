# Écrire un connecteur

Public : développeur qui ajoute ou modifie un connecteur. Objet : l'interface d'un module de `hub/connectors/`, les
étapes et ce qui est refusé.

Un connecteur est un module ES de 50 à 210 lignes, listé dans `CONNECTORS` de `server.js`. Il reçoit seulement le
jeton qui le concerne, en argument ; il n'accède ni au store ni aux structures du hub. Règle : lecture seule, jeton
personnel, aucune abstraction partagée.

## 1. Interface

| Export | Obligatoire | Rôle |
|---|---|---|
| `id` | oui | identifiant court (`dropbox`) : clé dans `users.json`, préfixe de `/auth/<id>` et `/api/test/<id>` |
| `label` | oui | libellé du portail et de la ligne `Source : <label>` |
| `tools` | oui | outils MCP `{ name, description, input, run(tok, args, schema) }` ; `input` est un objet de champs zod (le *shape*), pas un `z.object` |
| `schema(tok)` | oui | structure (objets, champs, outils distants), en cache par utilisateur jusqu'à 03:00 ; `run` la reçoit comme fonction `schema()` |
| `ping(tok, schema)` | oui | diagnostic du portail : `{ message, tables? }` |
| `oauth` | si OAuth | `{ authUrl, tokenUrl, clientId, clientSecret, scope, extraAuthParams? }` ; configuré si `clientId` est présent |
| `apiKey` | si jeton saisi | `{ mode: "bearer" \| "basic", label }` : jeton ou identifiant et mot de passe saisis sur le portail |
| `identity(tok)` | non | e-mail du collaborateur, affiché sur le portail |
| `source()` | non | complément de la ligne Source (dossier, sandbox) |
| `domain` | non | domaine du portail (`commerce`, `finance`, `documents`…, sinon « autre ») ; `CONNECTOR_DOMAINS` le remplace |
| `mock` | non | `true` = simulateur sans jeton ; non exposé en production |
| `maxPerMinute` | non | plafond d'appels sortants par minute, tous utilisateurs confondus (0 = illimité) |
| `silent` | non | `true` = connexion sans interaction (`prompt=none`) juste après le SSO |

Le pseudo-connecteur `hub/sso.js` exporte en plus `bindIdentity`, `assertSame` et `next` ; un connecteur métier ne
les implémente pas.

Le hub gère autour de chaque `run` : clé, jeton (`withToken`), refresh sur 401, plafond, télémétrie, ligne Source,
erreurs. Un outil renvoie une chaîne, un objet (sérialisé en JSON) ou `{ $content }` (contenu MCP relayé tel quel).

## 2. Les trois familles

**REST avec jeton** (`sagex3.js`, `sharepoint.js`) : `fetch` en GET uniquement, `Authorization: Bearer` ou Basic,
chemins validés, délai borné (`AbortSignal.timeout`), erreurs réseau rendues lisibles par `unreachable(label, url, e)`
(`mcpclient.js`).

**Proxy d'un serveur MCP distant** (`salesforce.js`, `dropbox.js`, `myreport.js`) : `withMcp({ url, headers, sse?,
label }, fn)` ouvre un client MCP avec le jeton de l'utilisateur, exécute `fn(client)` et ferme la session. `schema`
liste les outils distants filtrés par une **liste blanche** de lecture. `<id>_tools` les expose ; `<id>_call` en
exécute un (`callRemote`). Liste blanche : codée pour Dropbox, `MYREPORT_TOOLS` pour MyReport ; Salesforce refuse
tout nom qui évoque une écriture. Modèle à suivre pour tout outil qui publie un serveur MCP officiel.

**Simulateur intégré** (`sagex3.js`, `myreport.js` sans URL) : `mock = true`, données inventées, aucun réseau.

## 3. Étapes

1. Créer `hub/connectors/<id>.js` sur le modèle de `dropbox.js` (proxy MCP) ou `sharepoint.js` (REST).
2. L'ajouter à `CONNECTORS` dans `server.js`. Portail, OAuth, diagnostic et télémétrie le prennent en compte sans
   autre modification.
3. Documenter ses variables dans `.env.example` (commentaire au-dessus de la ligne) et `docker-compose.yml` ; ajouter
   l'URI de rappel dans [configuration § 0](../admin/configuration.md#0-le-fichier-env-et-les-uri-de-rappel).
4. Écrire les tests (mock amont dans `hub/test/helpers/upstream.js`) : cas nominal, 401 + refresh, révocation, panne
   (injoignable, délai), outil d'écriture refusé, cloisonnement entre deux utilisateurs. Ajouter le système au bouchon
   `clevoa-mcp-stub/` si un test de bout en bout a du sens.
5. Ajouter sa ligne dans [l'état des fonctionnalités](../validation/etat-des-fonctionnalites.md), statut « testé sur
   bouchon » tant qu'un vrai compte ne l'a pas validé, et sa section dans [configuration](../admin/configuration.md).

## 4. Ce qui est refusé

* Toute écriture.
* Un compte technique ou un jeton lu depuis l'environnement.
* Un cache de données métier.
* Une dépendance non conforme à [dépendances § 1](dependances.md#1-politique-dajout).
* Un connecteur REST sur mesure quand un serveur MCP officiel existe.
* Une couche d'abstraction entre connecteurs avant un quatrième proxy.
