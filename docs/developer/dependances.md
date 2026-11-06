# Dépendances externes

Public : développeur et responsable sécurité. Objet : quelles dépendances le produit utilise, pourquoi, comment on en
ajoute une et comment on est prévenu d'une faille.

Règle : reprendre un composant éprouvé plutôt qu'écrire du code maison pour tout ce qui n'est pas propre au produit
(protocoles, sécurité, limites de débit).

## 1. Politique d'ajout

1. **Besoin** : elle remplace du code sensible ou complexe (protocole, cryptographie, format), pas trois lignes.
2. **Maintien** : publication récente, mainteneur identifié, failles corrigées vite.
3. **Poids** : peu de dépendances transitives (`npm ls --omit=dev` avant et après).
4. **Licence** : MIT, ISC, BSD, Apache-2.0. Jamais GPL ni AGPL dans ce qui est livré (contrôlé par la CI).
5. **Version figée** : version exacte dans `package.json` pour une dépendance de sécurité, fichier de verrouillage
   commité, installation par `npm ci`.
6. **Trace** : une ligne dans le registre ci-dessous et, si l'architecture change, dans les
   [décisions](../history/decisions.md).

## 2. Registre

### Hub (`hub/package.json`, livré chez le client)

| Dépendance | Version | Rôle | Licence |
|---|---|---|---|
| `@modelcontextprotocol/sdk` | ^1.32.1 | protocole MCP : serveur, client, transports, relais OAuth de l'accès en ligne | MIT |
| `express` | ^5.2.1 | serveur HTTP | MIT |
| `zod` | ^4.0.0 | validation des arguments des outils (requis par le SDK MCP) | MIT |
| `express-rate-limit` | 8.7.1 | toutes les limites de débit (IPv6 regroupées par /56) | MIT |
| `openid-client` | 6.8.8 | SSO Entra et SharePoint : code, refresh, id_token vérifié. Horloge juste requise (± 30 s, NTP) | MIT |
| `jose` | 6.2.13 | accès en ligne : vérification des jetons d'accès Entra | MIT |
| `fflate` | 0.8.3 | lecture des zip Office (docx, xlsx, pptx), décompression limitée aux entrées utiles ; aucune dépendance | MIT |
| `unpdf` | 1.9.1 | texte et images des PDF (pdf.js embarqué) ; aucune dépendance. `pdfjs-dist` écarté : 37 Mo et une dépendance native facultative | MIT |
| `node:sqlite` (intégré à Node 24) | — | `hub.db` ; API encore « release candidate », d'où un seul module (`db.js`), testé à chaque mise à jour de Node | domaine public |

Dépendance transitive notable : `oauth4webapi` (même auteur qu'openid-client). Inventaire complet : SBOM de la CI (§ 3).

### Autres composants

| Composant | Dépendances | Remarque |
|---|---|---|
| Bouchon `clevoa-mcp-stub` | SDK MCP, express, zod | pré-production seulement |
| Console `clevoa-console` (NAS de Clevoa) | `@aws-sdk/client-dynamodb` (version figée) | lecture seule sur la table |
| Backend `clevoa-backend` (AWS Lambda) | SDK AWS v3 **fourni par le runtime Lambda Node 22** ; Serverless Framework v4 pour le déploiement | invisibles du SBOM et de Dependabot. Licence du Serverless Framework v4 selon la taille de l'entreprise : à vérifier |

### Images et outils

| Élément | Version | Suivi |
|---|---|---|
| `node:24-alpine` (hub, bouchon, sauvegarde, console) | figée par empreinte | Dependabot (docker, docker-compose), Trivy image |
| `nginx:1.28-alpine` (profil `proxy`) | tag | Dependabot (docker-compose) |
| `cloudflare/cloudflared` (accès en ligne) | 2026.10.1, figée par empreinte | Dependabot (docker-compose) |
| Actions GitHub de la CI | figées par empreinte de commit | Dependabot (github-actions) |
| `semgrep/semgrep` (CI) | 1.181.1 | mise à jour manuelle |

## 3. Suivi automatique

La CI ([tests § 2](tests.md#2-intégration-continue)) tourne à chaque PR, à chaque push sur `main` et `dev`, et chaque
lundi sur `main` même sans commit : `npm audit`, SBOM CycloneDX avec contrôle des licences, Trivy (dépôt et images),
Semgrep, CodeQL, Gitleaks. Une faille publiée sur une dépendance existante met la CI en rouge.

Dependabot (`.github/dependabot.yml`) ouvre chaque lundi des PR vers `dev` pour npm, images et actions, sept jours
après la publication d'une version.

## 4. Mise à jour

1. Dependabot ouvre la PR vers `dev` (mineures et correctifs groupés, chaque majeure à part). Exclus : majeure de Node
   et mineure de nginx, qui proposeraient une version non LTS ou la branche de développement ; ces montées se décident
   à la main. L'empreinte de l'image Node se reporte à la main dans `docker-compose.yml`, `ops/backup.sh`,
   `ops/restore.sh` et `ops/test-backup-restore.sh` (`release.test.js` le vérifie).
2. La CI complète doit être verte, bout en bout sur le bouchon compris.
3. Version **majeure** : lire les notes de version, chercher les changements de comportement, noter la décision.
4. Fusion dans `dev`, puis livraison habituelle. Joindre à chaque Release les SBOM de l'artefact `sbom` du tag :
   c'est l'inventaire remis au client sur demande.
5. Faille critique sur une version livrée : branche `fix/…` depuis `main`, version corrective, information des
   clients concernés.

## 5. À faire hors du dépôt

Activer les **alertes Dependabot** et les **mises à jour de sécurité Dependabot** dans les réglages du dépôt : à faire
par le propriétaire.
