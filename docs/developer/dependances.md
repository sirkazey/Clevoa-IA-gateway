# Dépendances externes

Chaque dépendance est du code écrit par d'autres qui s'exécute chez le client. Règle du projet : **reprendre un composant
éprouvé plutôt qu'écrire du code maison** pour tout ce qui n'est pas propre au produit (protocoles, sécurité, limites de
débit…), et **savoir à tout moment lesquelles on utilise, pourquoi, et être prévenu** d'une faille ou d'une mise à jour.

## 1. Politique d'ajout

Avant d'ajouter une dépendance, vérifier :

1. **Besoin** : elle remplace du code sensible ou complexe (protocole, cryptographie, analyse de format), pas trois lignes.
2. **Maintien** : publication récente, mainteneur identifié, failles corrigées rapidement (historique des avis de sécurité).
3. **Poids** : peu de dépendances transitives (`npm ls --omit=dev` avant et après).
4. **Licence** : MIT, ISC, BSD, Apache-2.0. Jamais GPL ou AGPL dans ce qui est livré (contrôlé par la CI, § 3).
5. **Version figée** : version exacte dans `package.json` pour une dépendance de sécurité, fichier de verrouillage commité,
   installation par `npm ci`.
6. **Trace** : une ligne dans le registre ci-dessous et, si elle change l'architecture, dans les [décisions](../history/decisions.md).

## 2. Registre

### Hub (`hub/package.json`, livré chez le client)

| Dépendance | Version | Rôle | Licence | Pourquoi pas du code maison |
|---|---|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.32.1 | protocole MCP (serveur, client, transports, routeur OAuth du prototype) | MIT | SDK officiel du protocole |
| `express` | ^5.2.1 | serveur HTTP | MIT | standard Node |
| `zod` | ^4.0.0 | validation des arguments des outils | MIT | requis par le SDK MCP |
| `express-rate-limit` | 8.7.1 | toutes les limites de débit du hub (portail, échecs d'authentification, supervision, plafond par système) | MIT | remplace le limiteur maison (2026-10-25) ; déjà fourni par le SDK MCP. Effets : en-têtes `RateLimit` sur les réponses, adresses IPv6 regroupées par préfixe /56 |
| `openid-client` | 6.8.8 | SSO Entra et SharePoint : échange de code, refresh, vérification de l'id_token **signature comprise** | MIT | bibliothèque certifiée OpenID ; remplace la vérification maison sans signature (2026-10-25). Exige une horloge juste (± 30 s) : NTP sur l'hôte |
| `node:sqlite` (module intégré à Node 24, pas un paquet npm) | — | base d'exploitation `hub.db` : disponibilité, usage, audit (1.5) | domaine public (SQLite) | moteur SQLite embarqué par Node ; aucune dépendance native à compiler. Stabilité « release candidate » dans Node 24 : l'API peut encore évoluer, d'où un seul module (`db.js`) qui l'utilise et des tests sur chaque mise à jour de Node |

Dépendances transitives notables : `jose` et `oauth4webapi` (même auteur qu'openid-client, aucune dépendance propre).
Inventaire complet : le SBOM produit par la CI (§ 3), 97 composants en production au 25 octobre 2026, tous sous licence
MIT, ISC ou BSD.

### Autres composants

| Composant | Dépendances | Remarque |
|---|---|---|
| Bouchon `clevoa-mcp-stub` (pré-production seulement) | SDK MCP, express, zod | jamais installé chez un client en production |
| Console `clevoa-console` (NAS de Clevoa) | `@aws-sdk/client-dynamodb` (version figée) | lecture seule sur la table |
| Backend `clevoa-backend` (AWS Lambda) | **implicites** : SDK AWS v3 (`client-dynamodb`, `client-sns`) **fourni par le runtime Lambda Node 22**, Serverless Framework v4 pour le déploiement | invisibles du SBOM et de Dependabot : la version du SDK suit le runtime AWS. Conditions de licence du Serverless Framework v4 à vérifier selon la taille de l'entreprise |

### Images et outils

| Élément | Version | Suivi |
|---|---|---|
| `node:24-alpine` (hub, bouchon, sauvegarde, console ; Node 24.22.1 au 25 octobre 2026) | figée par empreinte | Dependabot (docker, docker-compose), Trivy image |
| `nginx:1.28-alpine` (profil `proxy`) | tag | Dependabot (docker-compose) |
| `cloudflare/cloudflared` (prototype « un clic », branche `proto/oauth-tunnel`) | 2026.10.0, figée par empreinte | Dependabot (docker-compose) une fois fusionné |
| Actions GitHub de la CI | figées par empreinte de commit (version en commentaire) | Dependabot (github-actions) met à jour l'empreinte et le commentaire |
| `semgrep/semgrep` (CI) | 1.181.1 | mise à jour manuelle |

## 3. Suivi automatique

| Outil | Ce qu'il surveille | Quand | Effet |
|---|---|---|---|
| `npm audit` | vulnérabilités HIGH/CRITICAL des dépendances de production (hub, bouchon, console) | chaque PR, push sur `main`/`dev`, chaque lundi | CI rouge |
| SBOM CycloneDX (`npm sbom`) + Trivy | inventaire des dépendances de production, vulnérabilités et **licences** interdites ou restrictives | idem | CI rouge ; SBOM en artefact `sbom` |
| Trivy (dépôt) | vulnérabilités des fichiers de verrouillage, secrets, configuration (Dockerfile, Compose) | idem | CI rouge |
| Trivy (images) | système Alpine, Node et dépendances des images construites | idem | CI rouge |
| Semgrep, CodeQL | défauts de sécurité du code du projet | idem | CI rouge |
| Gitleaks | secrets dans l'historique Git | idem | CI rouge |
| Dependabot (`.github/dependabot.yml`) | nouvelles versions npm, images, actions | chaque lundi, après 7 jours de publication | PR vers `dev` |

Le lundi, la CI repasse sur `main` même sans commit : une faille publiée dans la semaine sur une dépendance existante fait
apparaître la CI en rouge.

## 4. Mise à jour

1. Dependabot ouvre la PR vers `dev` (mineures et correctifs groupés, chaque majeure à part). Exclus : version majeure de
   Node et version mineure de nginx, qui proposaient une version non LTS (Node 25) ou la branche de développement de nginx
   (1.29) ; ces deux montées se décident à la main, vers une LTS de Node ou la stable suivante de nginx.
2. La CI complète doit être verte, y compris les tests de bout en bout sur le bouchon.
3. Mise à jour **majeure** : lire les notes de version, chercher les changements de comportement (sécurité, valeurs par
   défaut), noter la décision si elle change quelque chose.
4. Fusion dans `dev`, puis livraison selon le circuit habituel (tag, Release). À chaque Release, joindre les SBOM de
   l'artefact `sbom` de la CI du tag : c'est l'inventaire remis au client sur demande.
5. Faille critique sur une version déjà livrée : correctif hors calendrier (`fix/…` depuis `main`), nouvelle version
   corrective, information des clients concernés.

## 5. Ce qui reste à faire hors du dépôt

* Activer dans les réglages du dépôt les **alertes Dependabot** et les **mises à jour de sécurité Dependabot** (réglages de
  sécurité du dépôt : à faire par le propriétaire, pas par une modification de code).
