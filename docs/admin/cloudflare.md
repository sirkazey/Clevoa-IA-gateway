# Cloudflare : compte, tunnels et règles (service managé)

Public : l'exploitant Clevoa du service managé. Objet : tenir comme une production le compte Cloudflare qui publie
l'[accès en ligne](acces-en-ligne.md) de chaque client.

Ce compte voit **en clair** les échanges MCP de chaque client et contrôle la route vers chaque hub. Libellés et limites
des offres **à vérifier à l'écran**. Responsabilités : [service managé](../developer/architecture.md#9-service-managé--qui-exploite-quoi).

## 1. Compte (une fois)

- [ ] Compte propriétaire : double authentification par **clé de sécurité** (WebAuthn) ; codes de secours dans le coffre
      de Clevoa uniquement.
- [ ] Double authentification **obligatoire** pour tous les membres.
- [ ] Membres nominatifs, rôle minimal ; revue à chaque départ et chaque trimestre.
- [ ] Jamais la « Global API Key » : des **jetons d'API restreints** (permissions, zone, durée, adresses IP si possible),
      un par usage, inventoriés dans le coffre.
- [ ] Notifications de santé des tunnels vers l'adresse d'exploitation de Clevoa.
- [ ] Journal d'audit du compte relu chaque mois (membres, jetons, tunnels, règles).
- [ ] Zero Trust : nom d'équipe `clevoa` (`clevoa.cloudflareaccess.com`), offre gratuite.

## 2. Domaine et zone

La zone du domaine est gérée par Cloudflare (DNS complet). Le site et la messagerie du domaine restent en « DNS only »
(nuage gris) : seuls les noms d'hôte du service passent par Cloudflare.

- [ ] DNSSEC actif, enregistrement DS publié chez le registrar.
- [ ] Verrou de transfert chez le registrar.
- [ ] SSL/TLS : « Full (strict) », TLS 1.2 minimum, « Always Use HTTPS ».
- [ ] HSTS : seulement si tous les noms proxifiés sont en https, **sans** `includeSubDomains` ni `preload`.
- [ ] CAA : autoriser les autorités de Cloudflare **et** celle de l'hébergeur du site (à vérifier avant, sinon le site
      ne renouvelle plus son certificat).
- [ ] Aucun export de journaux (Logpush) avec les corps des requêtes.

**Nommage** : le certificat gratuit couvre un seul niveau (`*.<domaine>`). Un nom par client et par environnement :
`<client>.<domaine>` (production), `<client>-test.<domaine>` (pré-production) ; jamais `mcp.<client>.<domaine>`.

## 3. Tunnel d'un client (par environnement)

- [ ] Zero Trust → Réseaux → Tunnels → créer un tunnel *Cloudflared* `<client>-prod` ou `<client>-test`. Jamais partagé.
- [ ] Copier le **jeton** du tunnel dans `CLOUDFLARE_TUNNEL_TOKEN` (stack du client) et dans le coffre, nulle part
      ailleurs. Quitter l'assistant de création sans « Annuler » (il attend un connecteur en marche) ; la route s'ajoute
      ensuite depuis la fiche du tunnel.
- [ ] Démarrage côté client : `CLOUDFLARE_TUNNEL=1` et les variables de l'[accès en ligne § 5](acces-en-ligne.md#5-hub--variables-et-démarrage).
      Le tunnel passe « Healthy ». « Dégradé » avec des erreurs QUIC : l'UDP 7844 est bloqué et
      `CLOUDFLARE_TUNNEL_PROTOCOL` n'est pas à `http2` (défaut).
- [ ] Nom d'hôte public `<client>.<domaine>` ou `<client>-test.<domaine>` → service `http://mcp-hub:8090`. **Une seule
      route** ; règle finale « tout le reste » en 404. Jamais vers `:8080` (le hub refuse, 403, mais la règle doit être juste).

## 4. Règles de sécurité du nom d'hôte

Sécurité → WAF → Règles personnalisées, action **Bloquer**, deux règles par nom d'hôte (nombre limité en offre gratuite :
à vérifier). Remplacer `<hote>` ; recopier les adresses d'Anthropic depuis la
[liste officielle](https://platform.claude.com/docs/en/api/ip-addresses) le jour de la mise en place.

1. **Chemins autorisés seulement** (casse comprise) :

   ```
   (http.host eq "<hote>" and not (lower(http.request.uri.path) in {"/mcp" "/token" "/authorize" "/favicon.ico"}
     or starts_with(lower(http.request.uri.path), "/.well-known/oauth-")))
   ```
2. **`/mcp` et `/token` réservés au cloud d'Anthropic** :

   ```
   (http.host eq "<hote>" and lower(http.request.uri.path) in {"/mcp" "/token"}
     and not ip.src in {<plages d'Anthropic>})
   ```

`/authorize` (navigateur du collaborateur), `/favicon.ico` (logo) et `/.well-known/oauth-…` restent ouverts.

- [ ] « Bot Fight Mode » et blocage des robots d'IA **désactivés** pour ces noms (sinon Claude est bloqué), au besoin
      par une règle « Ignorer » (à vérifier).
- [ ] Cache : en cas de doute, règle de cache « Contourner » sur `<hote>`.

## 5. Contrôles après chaque mise en place ou modification

| # | Commande ou action | Attendu |
|---|---|---|
| 1 | `curl -s https://<hote>/.well-known/oauth-authorization-server` | JSON, `code_challenge_methods_supported` = `["S256"]` |
| 2 | `curl -s -o /dev/null -w '%{http_code}' https://<hote>/` | 403 (règle 1) |
| 3 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://<hote>/MCP` | 403 (règle 1, casse) |
| 4 | `curl -s -o /dev/null -w '%{http_code}' -X POST https://<hote>/mcp` depuis un poste | 403 (règle 2) |
| 5 | « Connecter » dans Claude | connexion aboutie (la règle 2 laisse passer Anthropic) |
| 6 | Tableau de bord du tunnel | « Healthy », une seule route vers `:8090` |
| 7 | Site et messagerie du domaine | inchangés (DNS only) |

## 6. Rotations

- **Jeton du tunnel** (départ d'un exploitant, doute, chaque année) : le faire tourner dans le tableau de bord, mettre à
  jour `CLOUDFLARE_TUNNEL_TOKEN`, *Update the stack*, contrôle 6. L'ancien jeton ne doit plus connecter (à vérifier).
- **Secret Entra du connecteur** (avant expiration) : nouveau secret, puis `ENTRAID_CLAUDE_CLIENT_SECRET` chez le client
  et dans le connecteur Claude (Owner), puis suppression de l'ancien.
- **Jetons d'API** : renouvelés à échéance, révoqués au départ de leur titulaire.

## 7. Retrait d'un client ou d'un environnement

1. `CLOUDFLARE_TUNNEL=0` dans la stack du client, puis *Update the stack* : le portail interne reste.
2. Supprimer le nom d'hôte public, puis le tunnel, puis les règles WAF du nom d'hôte.
3. Révoquer le secret Entra du connecteur ; l'Owner retire le connecteur dans Claude.
4. Consigner le retrait (date, client, environnement).

## 8. Incident : compte Cloudflare compromis ou doute

1. Couper l'exposition : chez chaque client, `docker compose … stop cloudflared` ; le portail interne continue.
2. Reprendre le compte (mot de passe, sessions, jetons d'API, membres) ; relire le journal d'audit.
3. Faire tourner les jetons de tunnel de **tous** les clients et les secrets Entra des connecteurs Claude.
4. Prévenir chaque client concerné selon le contrat (exposition possible de données).
5. Rétablir route par route, avec les contrôles du § 5.
