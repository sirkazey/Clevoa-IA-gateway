# Journal des tests sur systèmes réels

Document de validation : il consigne ce qui a été **réellement exécuté** contre les systèmes du client. Il est complété
à chaque campagne, jamais réécrit. Tests restants et limites : [état des fonctionnalités](etat-des-fonctionnalites.md).

Chaque entrée dit ce qui a été exécuté contre les systèmes Charlois, avec quel résultat, et ce que le hub a dû corriger. Les tests automatisés (hub, bouchon, backend Clevoa, scénario CI de sauvegarde et restauration ; [inventaire](../developer/tests.md))
tournent à chaque commit ; ils ne sont pas listés ici.

Compte utilisé pour la plupart des tests : le DSI du Groupe Charlois, profil **administrateur** sur chaque système testé.
Cloisonnement : vérifié le 05/11/2026 avec un compte collaborateur non administrateur (entrée C1–C3) sur Sage X3,
Salesforce et SharePoint ; Dropbox reste à vérifier avec un compte de l'équipe Dropbox Business du client.

## 2026-10-23 · Sage X3 préproduction (4CAD Cloud, Syracuse 24R1)

Instance `x3-test-ext-groupecharlois.4cadcloud2.com`, point de connexion `X3TST_CHREC` (dossier « Recette CHARLOIS
Salesforce PàP », copie fidèle des données), utilisateur X3 administrateur.

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| S1 | Sonde sans identifiant : `/api1/x3/erp` | 401 `Basic realm=Syracuse` : API REST exposée | Aucune action 4CAD nécessaire |
| S2 | curl Basic sur `X3TST_CHTST` | `No X3 user matching in this endpoint` | Compte rattaché à CHREC seulement |
| S3 | curl `$prototypes('BPCUSTOMER.$query')` sur CHREC | 200, structure complète | Format réel ≠ hypothèse du hub |
| S4 | curl `$query` BPCUSTOMER count=2 | 200, `$resources`, pagination `$links.$next` | Conforme au parseur |
| S5 | Portail « Tester Sage X3 » | 404 sur YFAC (liste par défaut héritée du bouchon) | Diagnostic rendu tolérant |
| S6 | Portail après `SAGE_REPRESENTATIONS` | Vert, 6 représentations ; SINVOICE, GACCENTRY absentes | Ticket 4CAD |
| S7 | curl `$prototypes` SINVOICE, GACCENTRY, GACCDUDATE | 500 « Unexpected token < » au 1er appel, puis 404 « does not exist » | Non publiées sur CHREC : ticket 4CAD |
| S8 | curl where avec espaces (`--data-urlencode`) | 400 « expected beginning of term » : `+` refusé | Hub : encodage `%20` |
| S9 | curl where `(FCY eq 'TO219')` encodé `%20` | 3 factures du site, identiques à l'écran Sage | OK |
| S10 | curl where `(AMTATI gt 400)` (champ hors liste) | 200, filtre appliqué, AMTATI non renvoyé | Limite documentée |
| S11 | curl `select=NUM,AMTATI` | Ignoré, mêmes colonnes ; enregistrements techniques `00000`, `001` en tête | Limite documentée, consigne de tri |
| S12 | Capture `capture-sage.ps1` (script non versionné) : prototypes liste et fiche de 6 représentations | Structures obtenues ; libellés en anglais (Accept-Language) | Fixtures de test anonymisées, `SAGE_LANG` |
| S13 | Claude Desktop : « Quelles représentations ? » | 6 noms, conteneur à jour | OK |
| S14 | Claude Desktop : « Décris PINVOICE » | 4 champs puis 6, libellés vides sur FCY/BPR, fiche en anglais | 3 corrections (exclus conservés, libellé `_REF`, langue) ; validé ensuite en français |
| S15 | Claude Desktop : « 3 dernières factures d'achat TO219 » | ENGIE, KOESIO, EDF, conformes | OK |
| S16 | Claude Desktop : « Détail TO2192607FAF0006 » | Fiche complète KOESIO, 80+ champs, lignes, TVA, analytique | OK ; fiche de 60 à 130 k caractères → paramètre `champs` |
| S17 | Claude Desktop : « factures SILICO payées en 2026 » | 10 factures, 97 850,88 € TTC ; « payées » non vérifiable ; date `'2026-01-01'` → 500 | Hub : dates converties en `@…@` ; GACCDUDATE demandée à 4CAD |
| S18 | Claude Desktop : « commandes Coppola 2026, barriques » | 20 commandes, 183 barriques ; données de test « Test FFC Winery » détectées par le modèle | Outils de découverte annoncent instance et dossier |
| S19 | Claude Desktop : « factures BIOEC > 400 € » | 4 pièces dont 2 avoirs AVF annulant 2 factures ; type de pièce non exposé | Piège documenté dans l'outil ; champ demandé à 4CAD |

Corrections du hub issues de ces tests : parseur de structure au format réel (champs sous `$resources.$item`, libellés
`{@n}`, compagnons `_REF`, blocs dépliés), encodage `%20`, dates `@…@`, tolérance par représentation (404 / 403 / 5xx),
`Accept-Language`, délai max par requête, structure chargée en parallèle, références aplaties en libellé, paramètre `champs`,
descriptions d'outils (colonnes de liste vs fiche, avoirs, enregistrements techniques), annonce de l'instance et du dossier.

Demandes ouvertes (ticket Redmine 4CAD #31562) : publier `SINVOICE`, `GACCENTRY`, `GACCDUDATE` sur CHREC ; exposer le type
de pièce sur PINVOICE et SINVOICE.

### Suite du ticket 4CAD #31562 (état au 3 novembre 2026)

Réponse de l'intégrateur, **non exercée par le hub** (aucun test exécuté depuis le 23/10) :

* champ `PIHTYP` (type de pièce, menu local 533 : 1 facture, 2 facture complémentaire, 3 avoir, 4 avoir/retour) ajouté à
  `PINVOICE` sur les dossiers CHDEV et CHREC seulement, pas en production ;
* `SINVOICE`, `GACCENTRY` et `GACCDUDATE` n'existent pas en standard (404 constaté en S7) : développement spécifique à
  chiffrer, en attente du recueil des besoins de la direction financière.

Suite donnée dans le hub (1.5.2) : note de `PINVOICE` sur `PIHTYP`, règle du numéro de pièce conservée ; `SINVOICE` et
`GACCENTRY` retirées de la liste par défaut. Test à faire sur CHREC : « Décris PINVOICE » puis « avoirs d'achat du mois »,
`PIHTYP` lu dans la liste ou dans la fiche.

## 2026-10-23 · Salesforce sandbox `preprod`

Org `charloisgroup--preprod.sandbox.my.salesforce.com`, serveur MCP hébergé « SObject Reads » de la sandbox, application
cliente externe « MCP Charlois » créée le jour même (PKCE, JWT, secret exigé, étendues `mcp_api` et `refresh_token`).

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| F1 | Sonde sans jeton du serveur MCP sandbox | 401 « JWT Token is required » ; métadonnées : serveur d'autorisation = sandbox, étendues `mcp_api`, `refresh_token`, PKCE S256 | Conforme au hub |
| F2 | Demande d'autorisation avec la clé consommateur, sans connexion | Redirection vers la page d'autorisation (clé, callback, étendues acceptés) | OK, sans attendre la propagation |
| F3 | Portail « Se connecter » puis « Tester Salesforce » | Vert : 6 outils `find`, `getObjectSchema`, `getRelatedRecords`, `getUserInfo`, `listRecentSobjectRecords`, `soqlQuery` | Noms provisoires du bouchon remplacés par les réels |
| F4 | Claude Desktop : « Qui suis-je ? » | Nom, e-mail, titre DSI Groupe, profil administrateur, locale fr_FR | E-mail du portail via `getUserInfo` |
| F5 | Claude Desktop : « 5 derniers comptes modifiés » | 5 comptes, dont modifications par « Interface X3 » (interface ERP active en préprod) | OK ; SOQL sans WHERE accepté → `LIMIT` par défaut ajouté |
| F6 | Dump complet de `salesforce_tools` | Schémas d'arguments réels (`q`, `objects`, `sobject-name`, `id`, `relationship-path`) | Bouchon et mocks alignés |

## 2026-10-26 · SharePoint et SSO Entra ID (locataire Charlois)

Pré-production sur le poste du DSI (Windows, Docker Desktop, `docker-compose.dev.yml`, `PUBLIC_URL=http://localhost:8080`),
réseau domestique sans VPN. Application Entra « Clevoa AI Gateway » de l'annuaire Charlois (consentement de l'utilisateur
seul, pas de consentement administrateur), site `charloisgroup.sharepoint.com:/sites/DSI`. Un seul compte : celui du DSI.
Les autres systèmes restaient sur le bouchon.

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| E1 | Connexion SharePoint depuis le portail (1.5.0-rc.1) | Mire Microsoft puis « Échec de la connexion SharePoint (réseau) » ; diagnostic sans problème signalé | Journal muet sur la cause : code d'erreur ajouté |
| E2 | `fetch` de la découverte OIDC depuis le conteneur | `ENETUNREACH` ; résolution système : 48 adresses IPv6 en double, aucune IPv4 ; en IPv4 seule : 8 adresses | Hub : résolution IPv4 d'abord (`resolve.js`) ; diagnostic : annuaire de connexion testé |
| E3 | Même connexion (1.5.0), diagnostic | `reseauConnexion` joignable (200) ; portail « Accès vérifié », site DSI | OK |
| E4 | Claude : « liste les sites SharePoint auxquels j'ai accès » | 42 sites du locataire | OK |
| E5 | `SSO_MODE=entra` : ancienne clé (sans identité) sur `/mcp` | 401 | OK |
| E6 | Fenêtre portant l'ancien cookie | Renvoi vers Microsoft ; SSO réussi ; puis retour SharePoint 400 | Hub : scope `profile` (sans lui, pas d'`oid` dans l'id_token, contrôle « même compte » toujours en échec) |
| E7 | Après correctif : portail, SharePoint, nouvelle clé dans Claude, ancienne clé, déconnexion puis reconnexion | Identité Entra affichée ; SharePoint connecté ; sites listés ; ancienne clé 401 ; même clé retrouvée après reconnexion | OK |
| E8 | SharePoint avec un autre compte Microsoft que celui du portail | Refusé | OK |
| E9 | Sage X3 « Se connecter » avec un vrai `SAGE_URL` | Parcours OAuth simulé du bouchon au lieu du formulaire Syracuse | Pré-prod : `SAGE_OAUTH_*` vides désactivent l'OAuth de Sage |

Non vérifié : `sharepoint_list`, `sharepoint_search` et `sharepoint_read` un par un ; cloisonnement entre deux
collaborateurs réels ; connexion SharePoint transparente pour un collègue (consentement administrateur non accordé) ;
compte invité.

## 2026-11-05 · Pré-production sur le serveur du client (Portainer, systèmes réels)

Serveur Docker du client, stack déployée par Portainer depuis un tag (1.6.0-rc1, puis 1.7.0-rc.1), `docker-compose.dev.yml`,
derrière le reverse-proxy nginx déjà en place chez le client (https, certificat du client, un fichier de site dédié). D'abord
sur le bouchon, puis Sage X3 (CHREC), Salesforce sandbox `preprod`, SharePoint et SSO Entra réels. Un seul compte réel : celui
du DSI, administrateur ; les deux comptes fictifs du bouchon pour le cloisonnement.

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| P1 | Déploiement Portainer depuis le tag, nginx existant (`proxy_pass` vers le port publié du hub) | `/health` 200 en https ; portail PRE-PROD | OK |
| P2 | `CONNECTORS_ENABLED=sagex3,salesforce,sharepoint` | trois applications au portail, outils des trois seuls systèmes | OK |
| P3 | Bouchon : Claude Desktop (`mcp-remote`, https) puis cloisonnement entre les deux comptes fictifs | réponses ; dossier restreint visible pour le seul compte autorisé | OK ; le bouchon expose sur PINVOICE un statut de règlement absent du vrai Sage : à aligner |
| P4 | SSO Entra (`SSO_MODE=entra`) | identité Entra au portail ; clés antérieures invalidées | OK |
| P5 | SharePoint juste après le SSO | authentification interactive au lieu de la connexion silencieuse | application sans consentement administrateur sur `Files.Read.All` et `Sites.Read.All` : permissions déclarées et consenties ; journaliser la raison du refus silencieux (à faire) |
| P6 | Sage X3 réel, identifiant et mot de passe Syracuse | « Accès vérifié », 6 représentations, aucune absente | liste par défaut de la 1.5.2 confirmée ; libellé « jeton personnel » du portail inexact (à corriger) |
| P7 | Salesforce sandbox réelle | « Accès vérifié », 6 outils SObject Reads | OK |
| P8 | Claude Desktop : « combien de comptes Salesforce ? » | total exact par `SELECT COUNT()`, plusieurs milliers, au-delà de la borne de 200 | correctif de la 1.4 confirmé |
| P9 | Claude Desktop : « décris PINVOICE » | `PIHTYP` présent dans les colonnes de liste sur CHREC ; consigne factures et avoirs suivie | test laissé en attente en 1.5.2 : fait |
| P10 | Claude Desktop : dossiers du site SharePoint DSI | dossiers listés selon les droits du compte | OK |
| P11 | Mise à jour de la stack 1.6.0-rc1 → 1.7.0-rc.1 depuis Portainer (référence de tag), accès en ligne non activé | connexions conservées, assistant toujours branché | OK ; message Portainer « Unable to retrieve stack file » sans effet, levé par *Pull and redeploy* |

Non vérifié : retour arrière sous Portainer ; accès en ligne (tunnel, connecteur Claude) ; compte non administrateur ;
lecture et recherche de documents SharePoint.

## 2026-11-05 · Cloisonnement avec un compte non administrateur (1.7.0-rc.3)

Une collaboratrice de la DSI, compte **non administrateur** sur chaque système, connectée au portail par le SSO Entra
avec sa propre identité, puis à Sage X3 et Salesforce avec ses propres comptes ; Claude Desktop par clé. Compte rendu
du propriétaire.

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| C1 | Sage X3 : questions sur les données du dossier de pré-production | réponses limitées à ses droits Syracuse | OK |
| C2 | Salesforce (sandbox) : questions sur les comptes et opportunités | réponses limitées à ses droits Salesforce | OK |
| C3 | SharePoint : dossiers du site de la DSI réservés au propriétaire | non visibles pour elle | OK |

Depuis la rc.3, les mêmes jetons personnels portent les nouveaux chemins (recherche Microsoft Search, lecture par
`driveId`, `dropbox_read`) ; Graph et Dropbox appliquent les droits du jeton. À refaire sur la version finale : une
recherche SharePoint sans site, puis la lecture d'un fichier réservé, avec le même compte (cinq minutes).

## 2026-11-06 · Dropbox (compte personnel de test)

Application Dropbox créée sur un compte personnel de test (trois documents fictifs), autorisations
`account_info.read files.metadata.read files.content.read sharing.read`, hub de pré-production. Aucun
compte Dropbox Business du client.

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| D1 | Connexion depuis le portail | refusée tant que « Autoriser les clients publics » n'est pas activé (« PKCE disallowed for this app »), puis OK | [configuration § 4](../admin/configuration.md#4-dropbox--vérifié-sur-un-compte-personnel-06112026) |
| D2 | Outils exposés par `mcp.dropbox.com` au jeton de l'application | 6 : `who_am_i`, `list_folder`, `search`, `get_file_metadata`, `list_shared_links`, `get_shared_link_metadata` | jeton d'une application tierce accepté |
| D3 | Recherche et liste de dossier depuis Claude | résultats conformes aux droits du compte | OK |
| D4 | `fetch` (lecture du contenu) | « unknown tool fetch » | 1.7.0-rc.7 : `dropbox_read` par l'API `files/download` |
| D5 | `search` avec `include_folders` | argument refusé par le serveur Dropbox | le hub le transmet tel quel ; rien à corriger côté hub |
| D6 | Question « informations sur <nom> » sans système | Claude n'a pas cherché dans Dropbox | 1.7.0-rc.7 : consignes du serveur, recherche dans tous les systèmes connectés |

Même session, SharePoint : `sharepoint_search` sans site a répondu 400 « Url specified is invalid » (cause exacte non
établie) ; 1.7.0-rc.7 passe par Microsoft Search. Lecture d'un docx ou xlsx : « Binaire : ouvrez webUrl » ; 1.7.0-rc.7
extrait le texte.

## 2026-11-06 · Lecture des documents (1.7.0-rc.7, Claude Desktop par clé)

Mêmes comptes de test ; un contrat scanné de 19 pages (PDF image, tableaux), fourni par le propriétaire, déposé dans
Dropbox et sur un site SharePoint de test. Le document n'est pas versionné ; aucun extrait n'en est consigné ici.

| # | Test | Résultat | Suite donnée |
|---|---|---|---|
| L1 | Dropbox : lecture du contrat scanné par `dropbox_read` | pages jointes en image, lues par Claude (résumé, montants, durée, résiliation) | **images transmises au modèle par Claude Desktop** : vérifié |
| L2 | SharePoint : `sharepoint_search` sans site | résultats sur plusieurs sites (Microsoft Search) ; plus de 400 | OK |
| L3 | SharePoint : `sharepoint_list`, `sharepoint_read` d'un fichier texte et du contrat scanné | lus ; mêmes pages qu'en Dropbox | OK |
| L4 | SharePoint : recherche d'un fichier déposé une minute plus tôt | non trouvé (index Microsoft Search en retard) ; Claude a conclu à tort à son absence | 1.7.0-rc.8 : note sur recherche vide, consigne « introuvable par la recherche » |

Reste à vérifier en réel : chiffres et dates d'un xlsx, texte d'un docx et d'un pptx, comparés par le testeur.

## Tests non encore réalisés

Liste tenue à jour dans [l'état des fonctionnalités § 3](etat-des-fonctionnalites.md#3-tests-restant-à-réaliser).
