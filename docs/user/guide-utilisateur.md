# Guide utilisateur

Public : le collaborateur qui interroge Salesforce, Sage X3, SharePoint, Dropbox ou MyReport depuis Claude.
Objet : connecter ses comptes une fois sur le portail, brancher Claude, lire les réponses. Tout se fait **avec vos droits,
en lecture seule**.

## 1. Connecter vos applications sur le portail

1. Ouvrez l'adresse du portail donnée par votre service informatique (exemple : `https://mcp.<entreprise>.fr`). Avec le
   SSO Microsoft, vous êtes reconnu automatiquement.
2. Dans **Vos applications**, cliquez **Se connecter** sur chaque ligne :
   * Salesforce, SharePoint / OneDrive, Dropbox : page de connexion de l'éditeur, puis autorisation « lecture » ;
   * Sage X3 : identifiant et mot de passe Syracuse, ou clé d'API, selon la configuration ;
   * MyReport : votre jeton personnel MyReport Server.
3. **Vérifier et enregistrer** teste vos identifiants avant de les garder. En cas de refus, un message rouge s'affiche
   et rien n'est enregistré.
4. Cliquez **Tout tester** : chaque ligne affiche « Accès vérifié » en vert, ou l'erreur en rouge.

Chaque ligne indique aussi l'état du service (« Opérationnel », « Lent », « Injoignable »…). Un service en erreur pour
tout le monde ne vient pas de votre compte : inutile de vous reconnecter. « Non configuré » : application pas encore
activée. « Simulé » : données inventées.

## 2. Brancher Claude

Le panneau **Brancher votre assistant** propose deux onglets, selon la configuration de votre entreprise.

### Onglet « Claude » (accès en ligne)

Pour claude.ai, l'application de bureau et le téléphone, sans clé à copier :

1. Dans Claude : Paramètres → Connecteurs.
2. Sur le connecteur Clevoa de votre entreprise, cliquez **Connecter**.
3. Connectez-vous avec votre compte Microsoft professionnel.

S'il n'apparaît pas, demandez à l'administrateur Claude de l'ajouter
([accès en ligne § 6](../admin/acces-en-ligne.md#6-claude--ajout-du-connecteur-par-lowner)). Libellés **à vérifier** au
premier essai. L'autre onglet, **Clé personnelle**, sert aux usages techniques (voir plus bas).

### Onglet « Claude Desktop » (sans accès en ligne)

Prérequis : Node.js installé (`node -v` répond). Libellés vérifiés sur Claude Desktop pour Windows le 23 octobre 2026.

1. Portail → onglet **Claude Desktop** → **Copier**.
2. Claude Desktop → votre nom en bas à gauche → Paramètres → Développeur → **Modifier la configuration**.
3. Dans `claude_desktop_config.json`, collez l'entrée **à l'intérieur** de `mcpServers`. Fichier vide : collez tout le bloc.
4. Quittez Claude Desktop par l'icône de la barre système (clic droit → Quitter), puis relancez-le. Le premier
   démarrage prend 10 à 20 secondes.
5. Nouvelle conversation → icône des outils : le serveur et ses outils apparaissent.

En cas d'échec : Paramètres → Développeur → Ouvrir les journaux → `mcp-server-<nom du serveur>.log`.

### Onglet « Claude Code et autres » ou « Clé personnelle »

Pour Claude Code ou un autre client MCP (adresse `<portail>/mcp`, en-tête `Authorization: Bearer <clé>`) : collez le
bloc dans `.mcp.json` à la racine du projet, relancez `claude`, vérifiez avec `/mcp`. Ou, en ligne de commande (syntaxe à
confirmer avec `claude mcp add --help`) :

```bash
claude mcp add --transport http clevoa-gateway <portail>/mcp --header "Authorization: Bearer <clé>"
```

Votre clé ouvre tous vos outils connectés : ne la partagez jamais.

## 3. Poser des questions

* « Avec quel compte suis-je connecté ? » ou « Qu'est-ce qui marche ? » : Claude indique votre compte Microsoft, les
  applications connectées (avec le lien pour connecter les autres) et un éventuel incident en cours.
* La section **Questions qui fonctionnent** du portail donne des exemples à copier d'un clic.
* Chaque réponse se termine par **« Source : … »** (système, dossier ou environnement) : vérifiez d'où vient la donnée.
* Si une application n'est pas connectée, Claude vous donne un lien vers la bonne ligne du portail. Connectez-vous,
  puis reposez la question.
* Sage X3 : une question sur beaucoup de pièces est lente. Restreignez la période ou le périmètre.
* Documents SharePoint et Dropbox : Claude lit les Word, Excel, PowerPoint et PDF. Un PDF scanné lui est transmis en
  images, 5 pages à la fois : demandez la suite au besoin ; la lecture dépend de la qualité du scan.

## 4. Gérer votre clé et vos connexions

* **Régénérer la clé** : l'ancienne cesse aussitôt de fonctionner. À faire si quelqu'un a pu la voir ; recopiez ensuite
  le bloc dans votre assistant.
* **Se déconnecter** (icône à droite de votre nom) ferme aussi la session Microsoft du navigateur : indispensable sur un
  poste partagé.
* **Déconnecter** une application retire vos accès à ce système.

## 5. Problèmes courants

| Ce que vous voyez | Que faire |
|---|---|
| « Non connecté à … » ou « Session … expirée ou révoquée », avec « Action requise : se connecter sur <lien> » | Ouvrir le lien, se connecter, reposer la question |
| Claude Desktop : erreur `401` | Clé régénérée : recopier le bloc du portail, relancer Claude Desktop |
| Sage X3 en rouge, `401` | Mot de passe Syracuse changé : ressaisir les identifiants |
| « interdites à votre utilisateur X3 (403) » | Normal : vos droits Sage X3 s'appliquent |
| « absentes de ce dossier (404) » | Signaler au service informatique ; le reste fonctionne |
| « plafond de N appels par minute atteint » ou « Trop de requêtes, réessayez dans une minute » | Attendre une minute |
| « Sage X3 : pas de réponse en 30 s » | Réessayer avec une question plus restreinte |
| « State OAuth invalide » | Ouvrir exactement l'adresse du portail donnée par le service informatique |
| Page de connexion Microsoft à chaque visite | Normal sans session Microsoft 365 dans ce navigateur |

Si le problème persiste, transmettez le message d'erreur à votre service informatique, **sans clé ni donnée métier**.
