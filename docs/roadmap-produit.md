# Roadmap produit

Public : direction, Clevoa, DSI cliente. Objet : sur quoi le produit évolue, et ce qu'il ne deviendra pas. Seule
roadmap active ; les précédentes sont archivées ([octobre 2026](history/roadmap-2026-10.md)).

État : aucune instance en production. Versions candidates 1.7.0 en pré-production chez le premier client depuis le
05/11/2026 ; version stable courante : 1.7.0 (06/11/2026). Statut de chaque fonction : [état des fonctionnalités](validation/etat-des-fonctionnalites.md).

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
| Tests réels de SharePoint (search, read), lecture Dropbox, MyReport | SharePoint et Dropbox faits le 06/11/2026 (journal L1–L4, G4) ; MyReport à faire | un appel réussi par outil sur un vrai compte, consigné au [journal](validation/journal-tests-reels.md) |
| Cloisonnement avec des comptes non administrateurs (Sage X3, Salesforce, SharePoint) | fait le 05/11/2026 (journal C1–C3) ; Dropbox à faire | un compte restreint ne voit que ses données, preuve consignée |
| Authentification et révocation (jeton Salesforce, mot de passe Syracuse, SSO `entra`) | à faire | voyant rouge et message de reconnexion constatés sur chaque système |
| Sauvegarde et restauration sur un serveur du client | restauration réelle faite le 06/11/2026 en pré-production (journal R1) ; une par trimestre ensuite | une restauration réelle, puis une par trimestre |
| Accès en ligne pour Claude et ChatGPT (expérimental) | premier essai réel le 06/11/2026 (journal O1–O4, G1–G4) ; critères 4 à 7 à faire | [critères](admin/acces-en-ligne.md#8-premier-essai--critères) tous consignés |
| Tout dans Claude, sans portail pour le collaborateur (décision du 06/11/2026) : liens de connexion utilisables hors réseau (pages de connexion derrière Cloudflare Access et Entra), SharePoint par On-Behalf-Of, inscription automatique du connecteur (CIMD), application Entra dédiée à l'accès en ligne, connexion des systèmes par le SSO Microsoft quand ils le permettent | prévu (1.8) | un collaborateur hors réseau connecte Sage X3 depuis le lien donné par Claude, sans VPN ni portail |
| Analyses de sécurité en CI sur chaque PR | fait | CI verte avant toute fusion |
| Compatibilité MCP : Claude Desktop ; Claude web et mobile, ChatGPT par l'accès en ligne | fait | journal S13–S19 et F4–F5 (23/10/2026), O1–O4 et G1–G4 (06/11/2026) |
| Compatibilité MCP : Claude Code, Copilot | à faire | une session réelle par assistant, consignée au journal |
| Anomalies remontées en recette | à faire | anomalie reproduite par un test, corrigée, publiée dans une version corrective |

Liste complète des tests réels restants : [état des fonctionnalités § 3](validation/etat-des-fonctionnalites.md#3-tests-restant-à-réaliser).

## 3. Axe 2 — Observabilité et maintenance

Objectif : Clevoa sait quelles installations tournent, en quelle version et avec quelle qualité de service, sans accès
à l'infrastructure ni aux données du client ; l'administrateur garde la main sur son déploiement.

| Sujet | Statut | Critère de sortie |
|---|---|---|
| Télémétrie éditeur, e-mails d'incident, [console de suivi](../clevoa-console/README.md) | fait (tests sans AWS), jamais déployé | validation juridique ([sécurité § 4](admin/securite.md#4-télémétrie-clevoa)) ; premier incident réel reçu et visible dans la console |
| Services éditeur sur Cloudflare, aucun compte AWS (décision du 06/11/2026) : télémétrie en Worker et Cron Trigger, données en D1 (stockage en Europe), e-mails d'incident envoyés par le Worker, console derrière Cloudflare Access ; même API pour le hub (`CLEVOA_URL`) | prévu, après la 1.7.0 | tests du backend repris sur D1 ; offre gratuite suffisante vérifiée ; premier incident réel reçu |
| Compte Cloudflare de Clevoa : il porte les tunnels des clients et les services éditeur | à faire avant le premier client en production | clé de sécurité physique pour chaque membre, membres réduits au strict nécessaire, journal d'audit relu ; procédure du [runbook § 8](admin/cloudflare.md#8-incident--compte-cloudflare-compromis-ou-doute) éprouvée |
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
