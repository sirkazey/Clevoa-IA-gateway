# Contribuer

Public : toute personne qui modifie le code ou la documentation. Objet : les règles de code, de livraison et de
rédaction.

Fil conducteur : rester une petite machine qu'un développeur Node lit en une heure. Pas de framework, pas de serveur
de base de données (SQLite intégré à Node seulement), pas de service en plus.

## 1. Code

* Branches : `dev` (intégration) et `main` (versions validées). Branche dédiée depuis `dev`, PR vers `dev`, puis `dev`
  vers `main`. Jamais de branche permanente par client.
* Une version est un tag `vX.Y.Z` sur `main`, jamais déplacé ; la pré-production reçoit des versions candidates
  `-rc.N`. Cycle complet : [installation § 6](admin/installation.md#6-cycle-de-livraison-et-versions).
* Version : `hub/version.js`, `hub/package.json` et `hub/package-lock.json` portent le même numéro, avec une section
  dans `CHANGELOG.md` (vérifié par `hub/test/release.test.js`).
* Toute correction vient avec un test de régression (`hub/test/`, `node:test`, aucun réseau). Un connecteur reste un
  module court ([écrire un connecteur](developer/connecteurs.md)).
* CI verte avant fusion : tests, sauvegarde et restauration, retour arrière, analyses de sécurité, liens de la
  documentation ([tests et analyses](developer/tests.md)).
* Jamais de secret, de jeton, d'identifiant personnel ni de donnée métier dans le code, les tests, les issues ou les
  commits. Les constantes de test sont inventées et listées dans `.gitleaks.toml` avec leur raison.

## 2. Documentation

### Structure et nommage

Un dossier par public : `docs/user/` (collaborateur), `docs/admin/` (administrateur), `docs/developer/` (développeur),
`docs/validation/` (DSI, recette), `docs/history/` (archives figées, jamais réécrites). Seule roadmap active :
`docs/roadmap-produit.md`. Index : [docs/README.md](README.md).

Fichiers en minuscules avec tirets, un sujet par fichier, pas de fichier de moins de vingt lignes. Un composant annexe
garde son `README.md` à côté de son code. À la racine : `README.md`, `CHANGELOG.md`, `LICENSE.md`, `.env.example` et
`CLAUDE.md` ([reprise du projet](developer/reprise-claude-code.md)).

### Rédaction

* Chaque document commence par son public et son objet en deux lignes.
* Phrases courtes, une idée par phrase. Dire ce que le produit fait, pas ce qu'il pourrait faire.
* Décrire l'état actuel ; l'historique des versions est dans `CHANGELOG.md`.
* Procédures numérotées ; tableaux pour comparer, pas pour mettre en forme.
* Commandes complètes, chemins exacts, valeurs fictives reconnaissables (`<PUBLIC_URL>`, `<org>`, `MDUPONT`). Une
  commande non testée est signalée « syntaxe à confirmer ».
* Une seule source de vérité par procédure ; les autres documents y renvoient par un lien relatif.
* Liens relatifs vers les fichiers du dépôt ; liens absolus pour les sites externes seulement.
* Chiffres et versions exacts, mis à jour dans la PR qui les change.

### Statut des fonctionnalités

Cinq mots, toujours les mêmes, dans [l'état des fonctionnalités](validation/etat-des-fonctionnalites.md) et partout
où un connecteur est décrit :

| Statut | Signification |
|---|---|
| **disponible** | livré et vérifié sur le système réel |
| **testé sur bouchon** | livré, couvert par les tests automatisés, jamais confronté au vrai système |
| **expérimental** | livré sans garantie, à activer explicitement, peut changer |
| **prévu** | inscrit dans la [roadmap produit](roadmap-produit.md), non livré ; jamais présenté comme existant |
| **non planifié** | écarté de la roadmap active ; ne revient qu'avec une nouvelle décision |

### Secrets et données sensibles

Aucun jeton, clé, mot de passe, identifiant personnel réel ni extrait de donnée métier. Une URL d'instance n'est
citée que si un test documenté en a besoin. Les procédures utilisent des valeurs entre chevrons. Les comptes rendus
citent le rôle (« compte administrateur »), pas la personne. Les rapports d'analyse de sécurité restent dans les
artefacts GitHub.

### Mise à jour dans les PR

Une PR qui change une variable, une commande, un comportement visible, un chiffre ou une limite met à jour la
documentation et `CHANGELOG.md` dans le même commit. Une PR qui déplace ou supprime un fichier corrige les liens qui y
menaient.

## 3. Contrôle des liens

`node ops/check-docs.js` parcourt tous les Markdown du dépôt (hors `node_modules`). Il échoue si un lien relatif vise
un fichier absent, si une ancre vise un titre inexistant, ou si un chemin cité entre accents graves n'existe plus. Il
tourne en CI sur chaque PR.
