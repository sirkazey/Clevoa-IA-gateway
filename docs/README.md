# Documentation Clevoa AI Gateway

Public : tout lecteur du dépôt. Objet : trouver le bon document. Un dossier par public ; chaque procédure a une seule
source de vérité, les autres documents y renvoient.

| Dossier | Public | Documents |
|---|---|---|
| `user/` | collaborateur | [démarrage rapide](user/demarrage-rapide.md) (une page, le premier jour), [guide utilisateur](user/guide-utilisateur.md) |
| `admin/` | administrateur | [installation](admin/installation.md), [configuration des connecteurs](admin/configuration.md), [SSO Entra ID](admin/sso-entra.md), [accès en ligne pour Claude](admin/acces-en-ligne.md), [Cloudflare (service managé)](admin/cloudflare.md), [exploitation](admin/exploitation.md), [sécurité](admin/securite.md) |
| `developer/` | développeur | [architecture](developer/architecture.md), [écrire un connecteur](developer/connecteurs.md), [tests et analyses](developer/tests.md), [dépendances](developer/dependances.md), [contribuer](CONTRIBUTING.md), [reprise dans Claude Code](developer/reprise-claude-code.md) |
| `validation/` | DSI, recette | [état des fonctionnalités et limites](validation/etat-des-fonctionnalites.md), [journal des tests réels](validation/journal-tests-reels.md), [campagne de charge v1.2.1](validation/charge-v1.2.1.md), [portail 1.4](validation/portail-v1.4.md) |
| `history/` | archives figées | [audits d'octobre 2026](history/audit-2026-10.md), [décisions](history/decisions.md), [feuille de route d'octobre 2026](history/roadmap-2026-10.md), [stabilisation d'octobre 2026](history/stabilisation-2026-10.md), [portail v1.3.1](history/portail-v1.3.1.md), [étude « connexion en un clic »](history/etude-connexion-un-clic.md) |

Seule roadmap active : [roadmap produit](roadmap-produit.md).

À la racine : [`README.md`](../README.md) (présentation), [`CHANGELOG.md`](../CHANGELOG.md) (versions),
[`LICENSE.md`](../LICENSE.md), [`.env.example`](../.env.example) (toutes les variables, commentées).
Composants annexes, documentés à côté de leur code : [bouchon d'entreprise](../clevoa-mcp-stub/README.md),
[backend de télémétrie](../clevoa-backend/README.md), [console de suivi](../clevoa-console/README.md),
[outils de charge](../loadtest/README.md).

Conventions de rédaction : [contribuer](CONTRIBUTING.md#2-documentation).
