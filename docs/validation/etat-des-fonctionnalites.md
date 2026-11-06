# État des fonctionnalités et limites connues

Public : DSI, recette, direction. Objet : ce qui est vérifié en version 1.7.0-rc.7, ce qui reste à prouver avant la
production, et les limites connues.

Les versions candidates 1.7.0 tournent depuis le 05/11/2026 sur le serveur de pré-production du client (1.7.0-rc.5 depuis le 06/11 ; Portainer, systèmes réels,
[journal P1–P11](journal-tests-reels.md)). Avant toute production manquent le cloisonnement avec un compte non
administrateur et une restauration réelle. Statuts : [conventions](../CONTRIBUTING.md#statut-des-fonctionnalités).
Historique : [`CHANGELOG.md`](../../CHANGELOG.md). Évolutions : [roadmap produit](../roadmap-produit.md).

## 1. Fonctionnalités

### Connecteurs et SSO

| Fonctionnalité | Statut | Preuve | Reste à faire |
|---|---|---|---|
| Sage X3 24R1, identifiant et mot de passe Syracuse | disponible | pré-production, 23/10/2026 (S1–S19) | compte restreint ; production |
| Sage X3, OAuth2 ou clé d'API `bearer` | testé sur bouchon | tests hub | un vrai IdP Syracuse |
| Salesforce, SObject Reads | disponible (sandbox) | 23/10/2026 (F1–F6) | production ; expiration du JWT et rotation du refresh token ; compte restreint |
| SharePoint / OneDrive (Graph délégué) | disponible (un compte) | 26/10 (E1–E8) et 05/11 (P5, P10) : connexion, liste des sites | chercher, lire ; second collaborateur ; revue de `Files.Read.All` et `Sites.Read.All` |
| SharePoint : recherche sur tous les sites (Microsoft Search), lecture Word, Excel, PowerPoint, PDF | testé sur bouchon | `docs.test.js`, `extract.test.js` | recherche sans site en réel (400 « Url specified is invalid » le 06/11 avec l'ancienne recherche) ; lecture réelle |
| Dropbox (serveur MCP officiel, compte personnel) | disponible | 06/11/2026 (D1–D6) : connexion, 6 outils, recherche et liste | dossiers d'équipe Dropbox Business ; cloisonnement avec un compte du client |
| Dropbox : lecture d'un fichier (`dropbox_read`, API `files/download`) | testé sur bouchon | `docs.test.js`, bouchon | lecture réelle d'un docx et d'un xlsx |
| PDF scannés : pages jointes en image, lues par Claude | testé sur bouchon | `extract.test.js`, `docs.test.js` | **à vérifier en réel** : le client MCP doit transmettre les images au modèle |
| MyReport (proxy MCP SSE) | testé sur bouchon | plomberie SSE et liste blanche | serveur de l'éditeur, non livré |
| SSO Entra ID (`entra`) | disponible (un compte) | 26/10 (E5–E8), `sso.test.js` | deux collaborateurs réels ; compte invité |
| Comptages exacts, listes coupées signalées (Salesforce, Sage X3) | testé sur bouchon | `mcp.test.js` | un comptage sur la sandbox ; `$links.$next` de Syracuse |

### Assistants et protocole

| Fonctionnalité | Statut | Preuve | Reste à faire |
|---|---|---|---|
| Claude Desktop via `mcp-remote` | disponible | 23/10/2026, Windows | |
| Claude Code, ChatGPT, Copilot | testé sur bouchon | tests de protocole seulement | une session réelle chacun, consignée au journal |
| claude.ai web et mobile : accès en ligne (`CLOUDFLARE_TUNNEL=1`) | expérimental | `online.test.js`, Entra simulé ([guide](../admin/acces-en-ligne.md)) | premier essai réel ; avis du DPO ; test d'intrusion |
| Protocole MCP 2024-10-07 à 2025-11-25, `readOnlyHint`, reconnexion SSE | testé sur bouchon | `compat.test.js` | |
| Transports Streamable HTTP et SSE | disponible | tests hub, charge | |

### Portail, sécurité, exploitation

| Fonctionnalité | Statut | Preuve | Reste à faire |
|---|---|---|---|
| Portail : connexion aux outils, diagnostic, blocs de configuration | disponible | pré-production | |
| Portail : lignes par domaine, colonne « Service », prénom, assistant à brancher, « Assistant : branché » | testé sur bouchon | tests du portail, axe-core ([compte rendu 1.4](portail-v1.4.md)) | revue par des collaborateurs |
| Chiffrement `users.json`, clé en en-tête, limitation de débit, en-têtes de sécurité | disponible | tests hub, ZAP passif | |
| État des systèmes, supervision (`/metrics`, `/metrics/prtg`) | testé sur bouchon | `health.test.js` | vérification HEAD sur le réseau du client ; capteur de supervision |
| Base d'exploitation `hub.db`, `admin.js` | testé sur bouchon | `db.test.js` | quelques semaines en pré-production |
| Journal d'audit (`AUDIT=on`) | testé sur bouchon | `db.test.js` | avis du DPO, information des collaborateurs |
| Sauvegarde automatique, restauration scriptée | testé sur bouchon | CI `backup-restore` | restauration sur un serveur du client, puis une par trimestre |
| Versions figées, retour arrière | testé sur bouchon | CI `rollback` | retour arrière sous Portainer |
| Diagnostic exportable, contrôle de santé | testé sur bouchon | `diagnostic.test.js` | un diagnostic chez le client |
| Reverse proxy nginx (profil `proxy`) | testé sur bouchon | `docker compose config` | déploiement réel |
| Capacité 50 collaborateurs | testé sur bouchon | [campagne de charge](charge-v1.2.1.md) | recette de charge en pré-production |

### Service Clevoa

| Fonctionnalité | Statut | Preuve | Reste à faire |
|---|---|---|---|
| Télémétrie toutes les 6 h ([sécurité § 4](../admin/securite.md#4-télémétrie-clevoa)) | testé sur bouchon | tests sans AWS | déploiement AWS, validation juridique |
| Incidents et e-mails | testé sur bouchon | SNS simulé | premier incident réel |
| Console de suivi | testé sur bouchon | données de démonstration | table réelle, installation sur le NAS |
| Mini-portail d'administration, connecteurs déclaratifs | non planifié | [roadmap § 5](../roadmap-produit.md#5-hors-roadmap) | |

## 2. Limites connues

* **Cloisonnement** observé avec un compte administrateur seulement : c'est la première preuve manquante.
* **Sage X3** : `sagex3_query` renvoie les colonnes de liste seulement. `PIHTYP` (type de pièce) n'est publié que sur
  les dossiers de recette ; la règle du numéro reste la référence. `GACCDUDATE`, `SINVOICE` et `GACCENTRY` sont absents
  en standard (développement spécifique à chiffrer). Fiche complète de 60 à 130 000 caractères (paramètre `champs`).
  Délai de 30 s par requête. Enregistrements techniques en tête, sans tri.
* **Salesforce** : une session MCP par appel (trois requêtes HTTP). Un 429 amont est rendu sans consigne. Usage
  facturé en crédits Flex (`SF_MAX_PER_MIN`).
* **MyReport** : 20 appels par minute pour tous les collaborateurs, première limite atteinte en charge.
* **SSO** : un compte désactivé dans Entra garde sa clé MCP jusqu'à régénération. Aucun outil ne retire une entrée de
  `users.json`. Activer le SSO sur une instance
  existante invalide toutes les clés.
* **Délais amont** : explicite pour Sage X3 seulement ; les autres suivent les défauts de Node et du SDK MCP. Sessions
  SSE abandonnées sans délai d'inactivité propre.
* **Débit MCP** : 300 requêtes par minute et par clé.
* **Charge** : mémoire stable sur 27 minutes (RSS ≤ 132 Mo), pas sur une journée ; quotas réels et 429 Graph non
  mesurés.
* **claude.ai** : accès en ligne jamais essayé en réel ; un seul annuaire Entra ; Cloudflare voit les échanges en
  clair.
* **Documents** : 25 Mo par fichier, 200 000 caractères de texte. PDF scanné : pas de reconnaissance de caractères
  dans le hub, 5 pages en image par demande, qualité selon le scan, coût en usage Claude. Images, anciens formats Office
  et PDF protégés par mot de passe non lus ([configuration](../admin/configuration.md#lecture-des-documents)).
* **Tests réels** : une seule personne, un seul profil.

## 3. Tests restant à réaliser

| Test | Prérequis |
|---|---|
| Cloisonnement avec un compte **non administrateur** (Sage X3, Salesforce) : seule preuve que le hub n'élargit pas les droits | un compte restreint sur chaque système |
| Expiration et renouvellement du jeton Salesforce (JWT ~ 2 h) | session ouverte plus de 2 h |
| Révocation : mot de passe Syracuse changé, autorisation Salesforce révoquée | action volontaire sur chaque système |
| Salesforce production | confirmation de l'intégrateur |
| Dropbox Business : dossiers d'équipe et cloisonnement avec un compte du client | application créée par l'administrateur de l'équipe Dropbox du client |
| Lecture réelle d'un docx et d'un xlsx, sur SharePoint et sur Dropbox | documents de test fictifs |
| Lecture réelle d'un contrat scanné (PDF) par Claude Desktop et par le connecteur en ligne : images transmises au modèle | PDF scanné de test |
| SharePoint : chercher sans site (Microsoft Search), lire ; second collaborateur | un collègue de la DSI |
| MyReport | serveur MCP de l'éditeur |
| SSO Entra avec deux collaborateurs réels | un second compte du client |
| Restauration sur un serveur du client (`sudo ops/restore.sh`) | accès au serveur, `ENCRYPTION_KEY` du coffre |
| Recette de charge en pré-production (`loadtest/run.js` adapté) | comptes de test, jamais la production |
| Exactitude financière (factures, avoirs, signes, devises, dates) | jeu de référence approuvé par la Finance |
| Injection de prompts par les données relayées | cas de test documentés |
| Comparaison croisée Sage X3 + Salesforce dans une réponse | |
| Claude Code, ChatGPT, Copilot : une session réelle chacun | poste avec l'assistant, clé MCP |
| Backend de télémétrie sur AWS, console sur le NAS | compte AWS Clevoa, validation juridique |
| Retour arrière sous Portainer (la mise à jour a été faite le 05/11) | stack sur un tag |
| Diagnostic exporté chez le client et relu | accès administrateur au serveur |
