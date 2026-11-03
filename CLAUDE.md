# Consignes pour Claude Code

Public : toute session Claude Code sur ce dépôt (chargé automatiquement). Objet : les règles et commandes à connaître
avant d'agir. Reprise complète (nouveau compte, nouvel environnement cloud) : [docs/developer/reprise-claude-code.md](docs/developer/reprise-claude-code.md).

## Projet

Clevoa AI Gateway (Clevoa SASU, propriétaire : Alexandre Chebrou de Lespinats) : hub MCP en lecture seule, Node 24,
qui donne aux assistants IA l'accès à Sage X3, Salesforce, SharePoint, Dropbox et MyReport avec les droits de chaque
collaborateur. Premier et seul client visé : Groupe Charlois. Dépôt `sirkazey/Clevoa-IA-gateway` (ancien nom
`Charlois-mcp-finance`, redirigé). Version courante : voir `hub/version.js` ; état réel : [état des fonctionnalités](docs/validation/etat-des-fonctionnalites.md).

## Règles non négociables

1. Aucun déploiement sur une infrastructure client ni modification d'une infrastructure de production ; aucun
   déploiement AWS réel sans autorisation explicite préalable.
2. Aucune suppression de secrets ou de données réelles ; aucun secret dans les commits, les journaux ou les réponses
   (ne jamais afficher `MS_CLIENT_SECRET` ni une clé du `.env`).
3. Aucun changement de droits GitHub ni de réglage de sécurité du dépôt ; jamais de `git push --force` sur une branche
   partagée ; aucune suppression de branche historique. Tags, Releases, suppression de branches, rulesets : le
   propriétaire les fait dans l'interface GitHub (le proxy de la session refuse ces opérations, 403).
4. Garder `proto/oauth-tunnel` (jamais fusionnée telle quelle) et `docs/roadmap-skills-adoption-2026-10` (non fusionnée).
5. Ne jamais déclarer un test réussi sans l'avoir lancé ; ne jamais classer une alerte SAST à la main ni contourner un
   contrôle pour obtenir du vert.
6. Aucune donnée métier réelle de Charlois (montants, noms de clients, contrats) dans le dépôt : le client déploie
   depuis ce dépôt.

## Livraison

1. Branche dédiée depuis `dev`, PR vers `dev` (fusion en squash), CI verte obligatoire.
2. PR `dev` → `main` (squash), puis réaligner `dev` : `git merge -s ours origin/main` poussé sur `dev` (contenu
   identique), sinon la livraison suivante est en conflit.
3. Version dans `hub/version.js`, `hub/package.json`, `hub/package-lock.json` et une section `CHANGELOG.md` (trois lignes
   au plus par rubrique) ; le propriétaire crée le tag `vX.Y.Z` et la Release sur le commit de `main`.
4. Pré-production en versions candidates `-rc.N` ; détails : [contribuer](docs/CONTRIBUTING.md).

## Commandes

Node 24 obligatoire (l'image cloud fournit Node 22) : `bash ops/claude-setup.sh` l'installe avec les dépendances.

| But | Commande |
|---|---|
| Tests du hub | `cd hub && npm test`, puis `APP_ENV=production npm test` |
| Bouchon, console, backend | `npm test` dans `clevoa-mcp-stub/`, `clevoa-console/`, `clevoa-backend/` |
| Documentation | `node ops/check-docs.js` |
| Docker (sauvegarde, retour arrière) | démarrer le démon : `nohup dockerd >/tmp/dockerd.log 2>&1 &` ; scénarios dans [tests](docs/developer/tests.md) |

Travailler dans un `git worktree` par branche ; jamais `git stash` sans étiquette.

## Style des réponses au propriétaire

Français. Conseiller, pas assistant : la conclusion d'abord, dire quand on ne sait pas (« Vérifie ça avant d'agir »),
exprimer un désaccord avec ses raisons et le maintenir sans argument nouveau, détailler brièvement les étapes du
raisonnement. Documentation : [conventions de rédaction](docs/CONTRIBUTING.md#2-documentation).
