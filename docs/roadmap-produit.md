# Roadmap produit

Public : direction, Clevoa, DSI cliente. Objet : sur quoi le produit évolue, et ce qu'il ne deviendra pas. Seule
roadmap active ; les précédentes sont archivées ([octobre 2026](history/roadmap-2026-10.md)).

État : aucune instance en production. Versions candidates 1.7.0 en pré-production chez le premier client depuis le
05/11/2026 (version courante : 1.7.0-rc.6). Statut de chaque fonction : [état des fonctionnalités](validation/etat-des-fonctionnalites.md).

## 1. Cadre

Le périmètre fonctionnel est **gelé** : connecteurs Salesforce, Sage X3, SharePoint / OneDrive, Dropbox et MyReport,
portail, SSO Entra ID, sauvegarde et restauration, télémétrie éditeur. Les exceptions sont des décisions datées
([décisions](history/decisions.md)) : portail et supervision, base d'exploitation et audit, accès en ligne pour Claude.

Le produit évolue seulement pour :

1. corriger des anomalies ;
2. améliorer la sécurité ;
3. rester compatible avec MCP et les assistants IA ;
4. rester compatible avec les API des applications métier ;
5. ajouter une intégration quand un client identifié en a besoin ;
6. faciliter l'exploitation et la maintenance.

Il ne deviendra pas un chatbot, un moteur LLM, un orchestrateur d'agents, un registre ou un outil de création d'Agent
Skills, une plateforme de gouvernance IA ni une plateforme de téléadministration. La formalisation des méthodes métier
et la création de Skills relèvent du conseil Clevoa et des fonctions natives des assistants.

Statuts de ce document : **fait** (livré, preuve citée), **à faire** (engagé, sans date), **sur besoin** (déclenché
par une demande client identifiée).

## 2. Axe 1 — Qualification et stabilisation

Objectif : passer de « testé sur bouchon » à « disponible » chez le premier client, sans ajouter de fonction.

| Sujet | Statut | Critère de sortie |
|---|---|---|
| Tests réels de SharePoint (list, search, read), Dropbox, MyReport | à faire | un appel réussi par outil sur un vrai compte, consigné au [journal](validation/journal-tests-reels.md) |
| Cloisonnement avec des comptes non administrateurs (Sage X3, Salesforce) | à faire | un compte restreint ne voit que ses données, preuve consignée |
| Authentification et révocation (jeton Salesforce, mot de passe Syracuse, SSO `entra`) | à faire | voyant rouge et message de reconnexion constatés sur chaque système |
| Sauvegarde et restauration sur un serveur du client | à faire | une restauration réelle, puis une par trimestre |
| Accès en ligne pour Claude (expérimental) | à faire | premier essai réel consigné ([critères](admin/acces-en-ligne.md#8-premier-essai--critères)) |
| Analyses de sécurité en CI sur chaque PR | fait | CI verte avant toute fusion |
| Compatibilité MCP : Claude Desktop | fait | journal S13–S19 et F4–F5 (23/10/2026) |
| Compatibilité MCP : Claude Code, ChatGPT, Copilot | à faire | une session réelle par assistant, consignée au journal |
| Anomalies remontées en recette | à faire | anomalie reproduite par un test, corrigée, publiée dans une version corrective |

Liste complète des tests réels restants : [état des fonctionnalités § 3](validation/etat-des-fonctionnalites.md#3-tests-restant-à-réaliser).

## 3. Axe 2 — Observabilité et maintenance

Objectif : Clevoa sait quelles installations tournent, en quelle version et avec quelle qualité de service, sans accès
à l'infrastructure ni aux données du client ; l'administrateur garde la main sur son déploiement.

| Sujet | Statut | Critère de sortie |
|---|---|---|
| Télémétrie éditeur, e-mails d'incident, [console de suivi](../clevoa-console/README.md) | fait (tests sans AWS) ; déploiement AWS et installation de la console à faire | validation juridique ([sécurité § 4](admin/securite.md#4-télémétrie-clevoa)) ; premier incident réel reçu et visible dans la console |
| État des systèmes sur le portail, supervision par `/metrics` | fait (tests sur bouchon) ; branchement chez le client à faire | un incident réel vu sur le portail et dans la supervision |
| Diagnostic exportable, relu avant envoi | fait | test automatisé de l'absence de valeur sensible |
| Versions figées, retour arrière | fait ; protection des tags `v*` à poser | [installation § 6](admin/installation.md#6-cycle-de-livraison-et-versions), `ops/test-rollback.sh` |
| Suivi du SDK MCP et des dépendances | à faire, à chaque version | `npm audit` et Trivy sans vulnérabilité haute ou critique corrigeable |

Pas de prise de contrôle à distance, pas de tunnel d'administration, pas de mise à jour imposée.

## 4. Axe 3 — Intégrations applicatives

Une application à la fois, sur demande d'un client identifié (statut **sur besoin**) :

* nouveau connecteur : un client et un cas d'usage nommés ; serveur MCP officiel en priorité, API REST en lecture
  sinon ([écrire un connecteur](developer/connecteurs.md)) ;
* adaptation aux évolutions des API, ou amélioration d'un connecteur : constat en recette, test de régression, puis
  correction.

Chaque intégration livre ses tests, sa section dans la [configuration](admin/configuration.md) et sa ligne dans l'état
des fonctionnalités. Un connecteur propre à un client est désactivé par défaut ; ni fork ni branche client.

## 5. Hors roadmap

Écartés, conservés pour mémoire dans les archives :

* registre et gestion d'Agent Skills (branche `docs/roadmap-skills-adoption-2026-10`, non fusionnée) ;
* interface web conversationnelle ou appel d'un LLM depuis le hub ;
* mini-portail d'administration, interface déclarative des connecteurs MCP
  ([archive § 2](history/roadmap-2026-10.md#2-catalogue-des-évolutions-possibles-optionnel-roadmap-clevoa)).

Une de ces pistes ne revient qu'avec une nouvelle décision datée et un client qui la demande.
