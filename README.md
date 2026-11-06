# Clevoa AI Gateway

Passerelle MCP **en lecture seule** entre les assistants IA (Claude Desktop, Claude Code, claude.ai, ChatGPT) et les outils
métier d'une entreprise : Salesforce, Sage X3, SharePoint / OneDrive, Dropbox, MyReport. Chaque appel porte le jeton
**personnel** du collaborateur : l'assistant ne voit que ce que le collaborateur a déjà le droit de voir. Le hub n'a
aucun compte technique.

Édité par Clevoa SASU. Premier client : Groupe Charlois (direction financière). Qualification en cours sur sa
pré-production ; aucune instance en production. Version courante : **1.7.0** (`hub/version.js`).

## Ce que fait la passerelle

* **Un conteneur Node 24**, sans framework ni serveur de base de données ([architecture](docs/developer/architecture.md)).
* **Droits de chaque collaborateur** : jetons OAuth ou identifiants individuels, chiffrés (AES-256-GCM), transmis tels
  quels aux outils.
* **Lecture seule par construction** : facettes de lecture uniquement, listes blanches d'outils, outils annotés
  `readOnlyHint`. Aucune donnée métier stockée.
* **Portail web** : connexion à chaque outil, état du service, assistant à brancher. SSO Entra ID facultatif.
* **Supervision** : état de chaque système exposé en Prometheus (`/metrics`) et PRTG (`/metrics/prtg`), jeton dédié.
* **Traçabilité** : chaque résultat se termine par `Source : <système>`.
* **Exploitation** : stacks Docker Compose de pré-production et de production, sauvegarde quotidienne, restauration
  scriptée, reverse proxy nginx fourni.

## Architecture

Le hub tourne sur l'infrastructure du client. Les assistants du réseau interne s'y branchent avec une clé personnelle.
L'accès hors réseau (claude.ai web et mobile, ChatGPT) passe par un tunnel Cloudflare sortant, sans port entrant, et Entra ID ;
il est expérimental et désactivé par défaut ([accès en ligne](docs/admin/acces-en-ligne.md)). Schéma, modules et répartition
des rôles : [architecture](docs/developer/architecture.md).

## Connecteurs

| Système | Protocole | Outils MCP | Statut |
|---|---|---|---|
| Sage X3 24R1 | API REST Syracuse | `sagex3_representations`, `sagex3_describe`, `sagex3_query`, `sagex3_get` | disponible (pré-production) |
| Salesforce | serveur MCP hébergé « SObject Reads » | `salesforce_tools`, `salesforce_call` | disponible (sandbox) |
| SharePoint / OneDrive | Microsoft Graph, Microsoft Search | `sharepoint_sites`, `sharepoint_list`, `sharepoint_search`, `sharepoint_read` | disponible (pré-production, un compte) ; lecture des documents vérifiée en réel |
| Dropbox | serveur MCP officiel, API `files/download` | `dropbox_tools`, `dropbox_call`, `dropbox_read` | disponible (compte personnel) ; lecture des documents vérifiée en réel ; dossiers d'équipe Dropbox Business non vérifiés |
| MyReport | serveur MCP SSE de l'éditeur | `myreport_tools`, `myreport_call` | testé sur bouchon (serveur éditeur non livré) |

Détail, preuves et limites : [état des fonctionnalités](docs/validation/etat-des-fonctionnalites.md).

## Démarrage rapide

Avec Docker Desktop et le bouchon d'entreprise (aucun compte réel, deux collaborateurs fictifs) :

```bash
cp .env.example .env                                   # renseigner ENCRYPTION_KEY : openssl rand -hex 32
docker compose -f docker-compose.dev.yml up -d --build  # hub + bouchon
open http://localhost:8080                              # exactement l'adresse de PUBLIC_URL
```

Sur le portail : se connecter à chaque outil (comptes Marie et Paul), puis brancher l'assistant. Tests sans Docker ni réseau : `cd hub && npm install && npm test`.

Suite : [installation](docs/admin/installation.md).

## Documentation

| Public | Documents |
|---|---|
| Collaborateur | [Démarrage rapide](docs/user/demarrage-rapide.md) · [Guide utilisateur](docs/user/guide-utilisateur.md) |
| Administrateur | [Installation](docs/admin/installation.md) · [Configuration](docs/admin/configuration.md) · [Exploitation](docs/admin/exploitation.md) · [Sécurité](docs/admin/securite.md) |
| Développeur | [Architecture](docs/developer/architecture.md) · [Tests](docs/developer/tests.md) · [Contribuer](docs/CONTRIBUTING.md) |
| DSI, recette | [État des fonctionnalités et limites](docs/validation/etat-des-fonctionnalites.md) · [Roadmap produit](docs/roadmap-produit.md) |

Index complet : [docs/README.md](docs/README.md).

## Sécurité et limites

* Sans jeton personnel, aucun outil ne répond. La clé maîtresse `ENCRYPTION_KEY` se garde au coffre : la perdre oblige
  chaque collaborateur à se reconnecter.
* La clé MCP personnelle passe uniquement en en-tête `Authorization: Bearer`, jamais dans l'URL.
* Télémétrie vers Clevoa limitée à des compteurs : aucun e-mail, jeton, requête ni résultat
  ([sécurité § 4](docs/admin/securite.md#4-télémétrie-clevoa)).
* Vérifiés en réel : Claude Desktop (par clé), Claude web et mobile et ChatGPT (accès en ligne, expérimental) ;
  Claude Code et Copilot au niveau du protocole seulement. Cloisonnement vérifié avec un compte non administrateur
  (Sage X3, Salesforce, SharePoint). Capacité de 50 collaborateurs démontrée sur bouchons seulement.

## Licence

Logiciel propriétaire de Clevoa SASU : [LICENSE.md](LICENSE.md). Versions : [CHANGELOG.md](CHANGELOG.md) et
[releases GitHub](https://github.com/sirkazey/Clevoa-IA-gateway/releases).
