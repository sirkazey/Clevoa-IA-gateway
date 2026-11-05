# Cloudflare : compte, tunnels et règles (service managé)

Public : l'exploitant Clevoa du service managé. Objet : tenir le compte Cloudflare de Clevoa, qui publie l'[accès en
ligne](acces-en-ligne.md) de chaque client, comme une production. Chaque étape se coche ; les libellés du tableau de bord et
les limites des offres sont **à vérifier à l'écran** (non vérifiés depuis le dépôt). Responsabilités de chacun :
[service managé](../developer/architecture.md#9-service-managé--qui-exploite-quoi).

Ce que Cloudflare voit : il termine le HTTPS des noms d'hôte publiés et voit **en clair** les requêtes et réponses MCP de
chaque client. Le compte donne aussi la main sur la route vers le hub interne du client. D'où les règles ci-dessous.

## 1. Compte (une fois)

- [ ] Double authentification par **clé de sécurité** (WebAuthn) sur le compte propriétaire ; codes de secours dans le coffre
      de Clevoa, jamais dans un fichier ni un ticket.
- [ ] Double authentification **obligatoire** pour tous les membres (paramètres du compte).
- [ ] Membres nominatifs, jamais d'identifiant partagé ; rôle minimal, limité au domaine utile dès qu'il y a plus d'un
      exploitant. Revue des membres à chaque départ et chaque trimestre.
- [ ] Jamais la « Global API Key ». Seulement des **jetons d'API restreints** (permissions, zone, durée de validité,
      adresses IP autorisées si possible), un par usage, inventoriés dans le coffre.
- [ ] Notifications : santé des tunnels (tunnel tombé ou dégradé) vers l'adresse d'exploitation de Clevoa.
- [ ] Journal d'audit du compte relu chaque mois (création de membres, de jetons, modification de tunnels ou de règles).
- [ ] Zero Trust : nom d'équipe choisi (`clevoa`, domaine `clevoa.cloudflareaccess.com`), offre gratuite activée.
- [ ] Le nouvel assistant de création de tunnel n'autorise « Continuer » qu'une fois un connecteur en marche : copier le
      jeton, quitter l'assistant sans « Annuler », puis ajouter la route depuis la fiche du tunnel une fois `cloudflared` démarré.

## 2. Domaine et zone

Zone du domaine du prestataire, gérée par Cloudflare (DNS complet). Le site et la messagerie du domaine restent en
« DNS only » (nuage gris) : seuls les noms d'hôte du service passent par Cloudflare.

- [ ] DNSSEC actif dans Cloudflare, enregistrement DS publié chez le registrar.
- [ ] Verrou de transfert chez le registrar.
- [ ] SSL/TLS : mode « Full (strict) », TLS 1.2 minimum, « Always Use HTTPS ».
- [ ] HSTS : seulement si tous les noms proxifiés sont en https, **sans** `includeSubDomains` ni `preload` (le site et la
      messagerie du domaine ne doivent pas en dépendre).
- [ ] CAA : autoriser les autorités de certification de Cloudflare **et** celle de l'hébergeur du site (à vérifier avant de
      poser l'enregistrement, sinon le site perd le renouvellement de son certificat).
- [ ] Aucun export de journaux (Logpush) contenant les corps des requêtes.

**Nommage** : le certificat gratuit couvre un seul niveau sous le domaine (`*.domaine`). Un nom par client et par
environnement : `<client>.<domaine>` (production) et `<client>-test.<domaine>` (pré-production), par exemple
`charlois-test.clevoa.fr` ; jamais `mcp.<client>.<domaine>`.

## 3. Tunnel d'un client (par environnement)

- [ ] Zero Trust → Réseaux → Tunnels → créer un tunnel *Cloudflared* nommé `<client>-prod` ou `<client>-test`. Un tunnel
      par client et par environnement, jamais partagé.
- [ ] Copier le **jeton** du tunnel directement dans la variable `CLOUDFLARE_TUNNEL_TOKEN` de la stack du client et dans le coffre ;
      jamais dans un e-mail, un ticket, une conversation ni le dépôt.
- [ ] Nom d'hôte public : `<client>.<domaine>` ou `<client>-test.<domaine>` → service `http://mcp-hub:8090`. **Une seule route** ; règle finale
      « tout le reste » en 404. Ne jamais router vers `:8080` (le hub refuse de toute façon, 403, mais la règle doit être juste).
- [ ] Démarrage côté client : `CLOUDFLARE_TUNNEL=1` et les variables de l'[accès en ligne § 5](acces-en-ligne.md#5-hub--variables-et-démarrage) ;
      le tunnel passe « Healthy » dans le tableau de bord.

## 4. Règles de sécurité du nom d'hôte

Sécurité → WAF → Règles personnalisées, action **Bloquer**, une paire par nom d'hôte (l'offre gratuite en compte un petit
nombre : à vérifier). Remplacer `<hote>` ; recopier les adresses d'Anthropic depuis la
[liste officielle](https://platform.claude.com/docs/en/api/ip-addresses) le jour de la mise en place.

1. **Chemins autorisés seulement** (tout le reste bloqué, casse comprise) :

   ```
   (http.host eq "<hote>" and not (lower(http.request.uri.path) in {"/mcp" "/token" "/authorize"}
     or starts_with(lower(http.request.uri.path), "/.well-known/oauth-")))
   ```
2. **`/mcp` et `/token` réservés à Claude** (appelés depuis le cloud d'Anthropic) :

   ```
   (http.host eq "<hote>" and lower(http.request.uri.path) in {"/mcp" "/token"}
     and not ip.src in {<plages d'Anthropic>})
   ```

`/authorize` reste ouvert (navigateur du collaborateur, au moment de « Connecter ») ; `/.well-known/oauth-…` aussi
(découverte par Claude).

- [ ] Robots : « Bot Fight Mode » et le blocage des robots d'IA **désactivés** pour ces noms d'hôte, sinon Claude est bloqué.
      Si le réglage ne vaut que pour toute la zone, l'exception passe par une règle « Ignorer » (à vérifier).
- [ ] Cache : rien n'est mis en cache (Cloudflare ne cache pas le JSON par défaut) ; en cas de doute, règle de cache
      « Contourner » sur `<hote>`.

## 5. Contrôles après chaque mise en place ou modification

| # | Commande ou action | Attendu |
|---|---|---|
| 1 | `curl -s https://<hote>/.well-known/oauth-authorization-server` | JSON, `code_challenge_methods_supported` = `["S256"]` |
| 2 | `curl -s -o /dev/null -w '%{http_code}' https://<hote>/` | 403 (règle 1) |
| 3 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://<hote>/MCP` | 403 (règle 1, casse) |
| 4 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://<hote>/mcp` depuis un poste | 403 (règle 2) |
| 5 | « Connecter » dans Claude | connexion aboutie (règle 2 laisse passer Anthropic) |
| 6 | Tableau de bord du tunnel | « Healthy », une seule route vers `:8090` |
| 7 | Site et messagerie du domaine | inchangés (DNS only) |

## 6. Rotations

- **Jeton du tunnel** (au départ d'un exploitant, en cas de doute, et chaque année) : dans le tableau de bord, faire tourner
  le jeton du tunnel ; mettre à jour `CLOUDFLARE_TUNNEL_TOKEN` dans la stack du client ; *Update the stack* ; contrôle 6. L'ancien jeton
  ne doit plus connecter (à vérifier selon la méthode de rotation proposée).
- **Secret Entra du connecteur Claude** (avant son expiration) : nouveau secret dans Entra, puis `ENTRAID_CLAUDE_CLIENT_SECRET` chez le
  client et le secret du connecteur dans Claude (Owner), puis suppression de l'ancien secret dans Entra.
- **Jetons d'API Cloudflare** : durée de validité courte, renouvelés à échéance, révoqués au départ de leur titulaire.

## 7. Retrait d'un client ou d'un environnement

1. `CLOUDFLARE_TUNNEL=0` dans la stack du client, puis *Update the stack* : le tunnel tombe, le portail interne reste.
2. Supprimer le nom d'hôte public, puis le tunnel, puis les règles du nom d'hôte.
3. Révoquer le secret Entra du connecteur Claude ; l'Owner retire le connecteur dans Claude.
4. Consigner le retrait (date, client, environnement).

## 8. Incident : compte Cloudflare compromis ou doute

1. Couper l'exposition : chez chaque client, arrêter `cloudflared` (`docker compose … stop cloudflared`) ; le portail
   interne continue de fonctionner.
2. Reprendre le compte : changer le mot de passe, révoquer les sessions, les jetons d'API et les membres suspects ; relire le
   journal d'audit (routes de tunnel, règles WAF, enregistrements DNS modifiés).
3. Faire tourner les jetons de tunnel de **tous** les clients et les secrets Entra des connecteurs Claude.
4. Prévenir chaque client concerné (Cloudflare voit les échanges en clair : possible exposition de données), selon le contrat.
5. Rétablir route par route, contrôles du § 5 à l'appui.
