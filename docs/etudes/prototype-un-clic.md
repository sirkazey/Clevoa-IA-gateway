# Prototype « connexion en un clic » : guide pas à pas

Branche `proto/oauth-tunnel`, jetable et jamais fusionnée telle quelle. Étude de référence : [connexion en un clic](connexion-un-clic.md).
But : prouver qu'un collaborateur connecte le hub à Claude en cliquant sur « Connect », puis sur le nom de son entreprise,
sans clé à copier, sans Node.js sur son poste et sans aucun port ouvert sur le pare-feu.

Ce prototype ne touche à aucune installation client. Sage X3 et MyReport y tournent en **simulateur** (données fictives) ;
seule l'identité des collaborateurs (nom, e-mail) passe par les vrais annuaires, à l'étape 2.

## 1. Ce que fait le prototype

```
 Claude (claude.ai, IP 160.79.104.0/21)          Navigateur du collaborateur
        │ HTTPS                                          │ HTTPS
        ▼                                                ▼
 ┌──────────── Cloudflare (mcp-proto.socle.si) ─────────────┐   pare-feu : règle WAF
 └──────────────────────────┬───────────────────────────────┘   /mcp /token /register /revoke = Claude seulement
                            │ tunnel SORTANT (cloudflared → Cloudflare, port 7844)
 ┌─────────── machine Docker (aucun port entrant) ──────────┐
 │ cloudflared ──► mcp-hub:8090  autorisation OAuth + /mcp  │
 │                 mcp-hub:8080  portail (local seulement)  │
 │ mcp-stub :4000  annuaires simulés (étape 1)              │
 └───────────────────────────────────────────────────────────┘
        │ OIDC (étape 2)
        ▼
 Entra Charlois · Entra Oakwood Cooperage · Google Workspace de la société acquise
```

Le parcours du collaborateur :

1. Dans Claude : Paramètres → Connecteurs → « Clevoa » → **Connect**.
2. Une fenêtre du hub s'ouvre : « Claude demande à lire… Choisissez le compte de votre entreprise ». Il clique sur
   **Continuer avec Microsoft (Charlois)** (ou Oakwood, ou Google).
3. Microsoft ou Google : déjà connecté, rien à faire ; sinon il saisit son compte comme chaque matin.
4. La fenêtre se ferme, Claude affiche « Connecté ». Fin.

| Page du hub (choix de l'annuaire et consentement) | Annuaire simulé (étape 1) | Compte refusé |
|---|---|---|
| ![Choix](prototype-un-clic/1-choix-annuaire.png) | ![Mire](prototype-un-clic/2-annuaire-simule.png) | ![Refus](prototype-un-clic/3-compte-refuse.png) |

Thème sombre : [capture](prototype-un-clic/1-choix-annuaire-sombre.png).

Ce qui est construit dans le hub (désactivé par défaut, `OAUTH=on` pour l'activer) :

* serveur d'autorisation OAuth 2.1 du SDK MCP : métadonnées RFC 9728 et RFC 8414, inscription dynamique (DCR), PKCE S256,
  `resource` (RFC 8707), `iss` dans la réponse (RFC 9207), révocation (RFC 7009) ;
* jetons **du hub** (jamais ceux de Microsoft ou Google) : accès de 15 minutes, refresh tourné à chaque usage, rejeu détecté
  (session révoquée), sessions persistées dans le fichier chiffré (empreintes seulement) ;
* annuaires OIDC multiples (code + PKCE + nonce) : Entra épinglé par l'ID de l'annuaire, Google limité au domaine Workspace
  (`hd`), autre OIDC limité aux e-mails vérifiés d'un domaine autorisé ;
* revalidation auprès de l'annuaire au plus toutes les 60 minutes : un compte désactivé perd l'accès au plus tard
  75 minutes après (60 + jeton de 15 min) ;
* un port à part (8090), le seul publié par le tunnel : il ne sert que l'autorisation et `/mcp`. Le portail, les clés
  statiques, la supervision et le diagnostic n'existent pas de ce côté ;
* adresses de retour acceptées à l'inscription : Claude (`claude.ai`, `claude.com`) et la boucle locale ; tout autre site est refusé.

## 2. Prérequis

| # | Prérequis | Qui | Pour quelle étape |
|---|---|---|---|
| 1 | **Nom de domaine** sur Cloudflare : `socle.si` (voir § 3) ou un domaine de test dédié | toi (accès au registraire de socle.si) | 1 |
| 2 | **Compte Cloudflare** gratuit, avec l'accès Zero Trust activé (nom d'équipe, offre Free) | toi | 1 |
| 3 | **Machine Docker** allumée pendant les essais : Docker Engine ou Desktop avec Compose v2, sortie Internet en 443 et 7844 (TCP et UDP) vers Cloudflare. Un portable suffit. | toi | 1 |
| 4 | **Navigateur sur cette même machine** (étape 1 : les annuaires simulés sont en `localhost:4000`) | toi | 1 |
| 5 | **Compte Claude** : un compte individuel (Free : un seul connecteur personnalisé ; Pro ou Max) pour l'essai, puis le rôle **Owner** de l'organisation Team de Charlois pour l'essai à plusieurs | toi | 1 et 3 |
| 6 | `git`, `openssl` (génération des clés) | toi | 1 |
| 7 | **Entra Charlois** : droit de créer une inscription d'application (Administrateur d'applications) et de donner le consentement administrateur (Administrateur d'applications cloud ou Administrateur général) ; deux comptes de test | DSI Charlois | 2 |
| 8 | **Entra Oakwood Cooperage** : un administrateur de cet annuaire, et le domaine exact des adresses (`oakwoodcooperage.com` est une hypothèse) | DSI Oakwood | 3 |
| 9 | **Google Workspace de la société acquise** : un compte de l'organisation autorisé à créer un projet Google Cloud, et le domaine principal Workspace | admin de la société acquise | 3 |
| 10 | **Avis DPO** avant l'étape 2 : Cloudflare termine le TLS et voit les échanges en clair (ici, des identités ; plus tard, des données métier) | DSI / DPO | 2 |

Coût : 0 € (Cloudflare Free, Tunnel gratuit, Claude Free ou existant). Le seul coût possible est un domaine de test
(environ 10 € par an) si tu choisis de ne pas toucher à socle.si.

## 3. socle.si ou un domaine de test ?

Pour publier `mcp-proto.socle.si` par un tunnel, **toute la zone `socle.si` doit être gérée par Cloudflare** : en offre
gratuite, Cloudflare exige de remplacer les serveurs DNS de la zone chez le registraire. La délégation partielle (CNAME)
est réservée aux offres Business et Enterprise.

Conséquences si tu passes socle.si chez Cloudflare :

* **tous** les enregistrements actuels doivent être recopiés avant la bascule : site web, `MX` et `TXT` de la messagerie
  (SPF, DKIM, DMARC), vérifications de domaine (Microsoft 365, Google). Cloudflare les importe automatiquement, mais
  l'import est incomplet en général (DKIM et sous-domaines peu courants) : compare avec un export de la zone actuelle ;
* si **DNSSEC** est actif chez le registraire de socle.si, il faut retirer l'enregistrement DS **avant** de changer de
  serveurs DNS, sinon le domaine devient injoignable ; on le réactive ensuite depuis Cloudflare ;
* la propagation prend de quelques minutes à 24 heures ;
* les enregistrements existants passent en « DNS only » (nuage gris) s'ils n'ont pas à transiter par Cloudflare : garde
  la messagerie et le site tels quels.

**Ma recommandation** : si socle.si porte une messagerie ou un site en service, achète un domaine de test dédié
(`socle-proto.fr` ou équivalent) pour le prototype et ne bascule socle.si qu'au moment d'un vrai service. Le risque n'est
pas la sécurité, c'est de casser la messagerie de socle.si pendant un essai. Si socle.si n'héberge rien d'important, utilise-le
directement. Dans la suite, remplace `socle.si` par le domaine choisi.

## 4. Étape 1 — Cloudflare et Docker avec les annuaires simulés (environ 1 h)

### 4.1 Ajouter le domaine à Cloudflare

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Add a domain** → `socle.si` → offre **Free**.
2. Vérifier la liste des enregistrements importés (comparer avec la zone actuelle, § 3).
3. Chez le registraire de socle.si : désactiver DNSSEC si actif, puis remplacer les serveurs DNS par les deux fournis par
   Cloudflare.
4. Attendre l'état **Active** de la zone (e-mail de Cloudflare).

### 4.2 Créer le tunnel

1. Tableau de bord Cloudflare → **Zero Trust** (première fois : choisir un nom d'équipe et l'offre Free).
2. **Networks → Tunnels** (selon la version de l'interface : **Networking → Tunnels**) → **Create a tunnel** →
   type **Cloudflared** → nom `clevoa-proto` → **Save tunnel**.
3. Écran d'installation : choisir **Docker**. La commande affichée contient `--token eyJ…` : copier **uniquement le
   jeton** (la longue chaîne après `--token`). C'est un secret : il permet de faire tourner le tunnel n'importe où.
4. **Next** / **Continue**, puis ajouter la route publique : onglet **Public Hostname** (ou **Routes → Add route →
   Published application** dans la nouvelle interface) :
   * Subdomain : `mcp-proto` ; Domain : `socle.si` ; Path : vide ;
   * Service : **HTTP**, URL : `mcp-hub:8090`.
5. Enregistrer. Cloudflare crée lui-même l'enregistrement DNS `mcp-proto` (CNAME vers le tunnel). Le certificat
   universel de Cloudflare couvre `mcp-proto.socle.si` (un seul niveau de sous-domaine ; `a.b.socle.si` ne le serait pas).

Le hub ne sert, sur ce port 8090, que l'autorisation et `/mcp` : même sans filtrage de chemin chez Cloudflare, le portail
n'est pas joignable depuis Internet.

### 4.3 Lancer la pile Docker

```bash
git clone https://github.com/sirkazey/Clevoa-IA-gateway.git && cd Clevoa-IA-gateway
git checkout proto/oauth-tunnel
cp .env.proto.example .env.proto        # .env.proto n'est jamais commité (.gitignore)
openssl rand -hex 32                    # → ENCRYPTION_KEY dans .env.proto
```

Dans `.env.proto` : `PROTO_HOST=mcp-proto.socle.si`, `CLOUDFLARE_TUNNEL_TOKEN=<jeton>`, `ENCRYPTION_KEY=<clé>`. Laisser
les variables `OIDC_*` vides à cette étape (annuaires simulés).

```bash
docker compose -f docker-compose.proto.yml --env-file .env.proto up -d --build
docker compose -f docker-compose.proto.yml --env-file .env.proto ps        # mcp-hub « healthy »
docker compose -f docker-compose.proto.yml --env-file .env.proto logs cloudflared | grep -i registered   # 4 connexions
docker compose -f docker-compose.proto.yml --env-file .env.proto logs mcp-hub | grep "Serveur OAuth"
```

Contrôles depuis la machine (avant la règle WAF du § 4.4) :

```bash
curl -s https://mcp-proto.socle.si/.well-known/oauth-protected-resource/mcp     # JSON : "resource": "https://mcp-proto.socle.si/mcp"
curl -s https://mcp-proto.socle.si/.well-known/oauth-authorization-server       # JSON : S256, registration_endpoint…
curl -si -X POST https://mcp-proto.socle.si/mcp | head -5                        # 401 + WWW-Authenticate: Bearer … resource_metadata=…
curl -si https://mcp-proto.socle.si/ | head -1                                   # 404 : pas de portail côté public
```

Le portail reste disponible en local sur `http://localhost:8080`. Sans connexion Internet du tunnel, le serveur OAuth se
teste aussi en local sur `http://localhost:8090` (par exemple avec l'inspecteur MCP).

**Docker sur une autre machine que le navigateur** (NAS, serveur) : à l'étape 1 seulement, les annuaires simulés doivent
être joignables par le navigateur. Dans `.env.proto` : `STUB_PORT=0.0.0.0:4000` et
`BROWSER_URL_REWRITE=http://mcp-stub:4000=>http://<IP du serveur>:4000`. Ce port n'expose que le simulateur, et seulement
sur le réseau local.

### 4.4 Règles Cloudflare

Tableau de bord → zone `socle.si` :

1. **Security → WAF → Custom rules → Create rule** (offre gratuite : 5 règles).
   * Nom : `Clevoa : MCP réservé à Claude`.
   * Expression (bouton **Edit expression**) :
     ```
     (http.host eq "mcp-proto.socle.si" and http.request.uri.path in {"/mcp" "/token" "/register" "/revoke"} and not ip.src in {160.79.104.0/21})
     ```
   * Action : **Block**.
   * Les pages vues par le navigateur du collaborateur (`/authorize`, `/oauth/…`) et les métadonnées (`/.well-known/…`)
     restent ouvertes : elles ne donnent accès à aucune donnée.
2. **Security → Bots** : **Bot Fight Mode** sur **Off** pour la zone. Il peut bloquer les appels serveur de Claude, et ne
   se contourne pas par une règle WAF (documentation Cloudflare). Vérifier aussi que le blocage des robots d'IA
   (« Block AI bots » / AI Crawl Control) n'est pas actif sur ce nom d'hôte.
3. **SSL/TLS** : mode indifférent pour le tunnel ; laisser **Always Use HTTPS** actif.

`160.79.104.0/21` est la plage sortante publiée par Anthropic pour les appels MCP
([adresses IP d'Anthropic](https://platform.claude.com/docs/en/api/ip-addresses), consultée le 25 octobre 2026). Vérifie-la
avant d'agir : si elle change, Claude est bloqué sans autre message qu'un échec de connexion. Cette règle bloque aussi
Claude Code et les clients installés sur un poste (ils appellent depuis l'adresse du poste) : c'est voulu pour le prototype.

Contrôle : `curl -si -X POST https://mcp-proto.socle.si/mcp | head -1` depuis ta machine renvoie maintenant **403**
(Cloudflare), et plus 401.

### 4.5 Connecter Claude (annuaires simulés)

Compte Claude individuel :

1. claude.ai → **Paramètres → Connecteurs** → **Ajouter un connecteur personnalisé** (Add custom connector).
2. Nom : `Clevoa (prototype)` ; URL : `https://mcp-proto.socle.si/mcp`. Ne rien mettre dans les paramètres avancés
   (Client ID, secret) : Claude s'inscrit lui-même auprès du hub.
3. **Ajouter**, puis **Connect** : la page du hub s'ouvre → **Continuer avec Microsoft (Charlois)** → sur l'annuaire simulé,
   choisir **Marie Dupont** → la fenêtre se ferme, le connecteur est **connecté**.
4. Nouvelle conversation → bouton **+** → **Connecteurs** : activer « Clevoa (prototype) ». Demander :
   *« Liste les représentations Sage X3 disponibles, puis montre les factures (YFAC). »* La réponse cite
   « Source : Sage X3 · simulateur ».

Organisation Team (après l'essai individuel) : l'Owner ajoute le connecteur dans **Paramètres de l'organisation →
Connecteurs → Ajouter → Personnalisé → Web** (même URL) ; chaque membre le retrouve dans ses connecteurs, marqué
« Custom », et clique **Connect**. L'application de bureau Claude reprend les connecteurs du compte : rien à installer.

## 5. Étape 2 — Le vrai Entra de Charlois (environ 30 min, DSI Charlois)

1. [entra.microsoft.com](https://entra.microsoft.com) → **Applications → Inscriptions d'applications → Nouvelle inscription** :
   * Nom : `Clevoa AI Gateway (prototype)` ;
   * Types de comptes : **comptes de cet annuaire organisationnel uniquement** (un seul locataire) ;
   * URI de redirection : plateforme **Web**, `https://mcp-proto.socle.si/oauth/callback/charlois`.
2. **Certificats et secrets → Nouveau secret client** (durée courte, 3 à 6 mois pour un prototype) : copier la **valeur**
   immédiatement (elle ne se réaffiche pas).
3. **Autorisations d'API** : Microsoft Graph, déléguées `openid`, `profile`, `email`, `offline_access` (et `User.Read`
   présente par défaut) → **Accorder le consentement administrateur pour Charlois** (sinon chaque collaborateur verrait un
   écran de consentement Microsoft).
4. Recommandé pour un pilote : **Applications d'entreprise → Clevoa AI Gateway (prototype) → Propriétés → Affectation
   requise : Oui**, puis **Utilisateurs et groupes** : n'affecter que le groupe pilote. Les autres comptes Charlois sont
   refusés par Microsoft avant même d'atteindre le hub.
5. Page **Vue d'ensemble** : noter l'**ID de l'annuaire (locataire)** et l'**ID d'application (client)**.
6. Dans `.env.proto` :
   ```
   OIDC_CHARLOIS_ISSUER=https://login.microsoftonline.com/<ID de l'annuaire>/v2.0
   OIDC_CHARLOIS_CLIENT_ID=<ID d'application>
   OIDC_CHARLOIS_CLIENT_SECRET=<valeur du secret>
   OIDC_CHARLOIS_DOMAINS=charlois.com          # facultatif : domaines des identifiants (UPN) acceptés
   OIDC_PROVIDERS=charlois                     # n'afficher que Microsoft (Charlois) pendant cet essai
   ```
7. `docker compose -f docker-compose.proto.yml --env-file .env.proto up -d` (le hub redémarre ; les connexions déjà
   faites avec l'annuaire simulé restent valables jusqu'à leur revalidation, puis demandent une reconnexion).
8. Dans Claude : **Disconnect** puis **Connect**. La page du hub n'affiche plus que « Continuer avec Microsoft (Charlois) » ;
   Microsoft reconnaît la session Windows ou Edge du collaborateur, ou demande le compte et la MFA habituelle.

Le hub identifie le collaborateur par son `oid` Entra et l'ID de l'annuaire, comme le SSO du portail : un collaborateur
déjà connu du portail retrouve la même identité. L'adresse e-mail ne sert qu'à l'affichage (dans Entra, elle est modifiable).

## 6. Étape 3 — Oakwood Cooperage et la société acquise

**Oakwood Cooperage (autre annuaire Entra).** Le plus simple : l'administrateur d'Oakwood crée sa propre inscription
d'application dans son annuaire, exactement comme au § 5, avec l'URI de redirection
`https://mcp-proto.socle.si/oauth/callback/oakwood`. Il te transmet l'ID de son annuaire, l'ID d'application et le secret
(par un canal sûr). Variables : `OIDC_OAKWOOD_ISSUER`, `_CLIENT_ID`, `_CLIENT_SECRET`, et `OIDC_OAKWOOD_DOMAINS` = domaine(s)
des comptes Oakwood. Alternative : une application multilocataire dans l'annuaire de Charlois, consentie par l'administrateur
d'Oakwood ; plus centralisée, mais elle demande une décision des deux DSI.

**Société acquise (Google Workspace).** Avec un compte de l'organisation Google de la société acquise :

1. [console.cloud.google.com](https://console.cloud.google.com) → créer un projet `clevoa-proto`.
2. **Google Auth Platform** (anciennement « Écran de consentement OAuth ») → type d'audience **Interne** : seuls les comptes de
   cette organisation peuvent se connecter, et Google n'exige aucune validation de l'application. Nom de l'application :
   `Clevoa AI Gateway (prototype)`. Accès aux données : `openid`, `email`, `profile`.
3. **Clients → Créer un client → Application Web** : URI de redirection autorisée
   `https://mcp-proto.socle.si/oauth/callback/acquise`. Copier l'ID client et le secret.
4. Variables : `OIDC_ACQUISE_ISSUER=https://accounts.google.com`, `_CLIENT_ID`, `_CLIENT_SECRET`, et
   `OIDC_ACQUISE_DOMAINS=<domaine Workspace>`. Le hub n'accepte que les comptes portant ce domaine Workspace (revendication
   `hd`) : un compte Gmail personnel est refusé même s'il passait l'écran de Google. À vérifier sur un vrai compte : pour un
   utilisateur d'un domaine secondaire du Workspace, la valeur de `hd` ; mettre au besoin tous les domaines dans la liste.

Google ne redonne un refresh token (nécessaire à la revalidation) qu'avec `prompt=consent` : les comptes Google voient un
écran de consentement Google à chaque connexion, soit une fois tous les 30 jours d'inactivité au plus. Accepté pour le
prototype ; à reconsidérer pour un service.

Puis `OIDC_PROVIDERS=charlois,oakwood,acquise` et redémarrage : la page du hub propose les trois comptes.

## 7. Critères de réussite

| # | Vérification | Attendu |
|---|---|---|
| 1 | Métadonnées en https (§ 4.3) | JSON, `resource` = `https://mcp-proto.socle.si/mcp` |
| 2 | « Connect » dans Claude | 2 clics (Connect, nom de l'entreprise) + Microsoft ou Google s'il n'y a pas de session ouverte |
| 3 | Question Sage X3 dans Claude | réponse avec « Source : Sage X3 · simulateur » |
| 4 | Deux collaborateurs | deux identités distinctes ; le second ne voit rien du premier |
| 5 | Application de bureau Claude | le connecteur y est déjà, connecté |
| 6 | Compte Gmail personnel sur « Google (société acquise) » | page « Connexion impossible » |
| 7 | Compte désactivé dans l'annuaire (étape 1 : `curl -X POST localhost:4000/oidc/_admin/disable -H 'Content-Type: application/json' -d '{"email":"paul.martin@charlois.com"}'`) | accès coupé en 75 minutes au plus ; 16 minutes avec `OAUTH_REVALIDATE_MIN=1` |
| 8 | `docker compose … restart mcp-hub` | Claude continue sans reconnexion (refresh) |
| 9 | `curl -X POST https://mcp-proto.socle.si/mcp` depuis ton poste | 403 Cloudflare (règle WAF) |
| 10 | `https://mcp-proto.socle.si/` | 404 : pas de portail |
| 11 | Pare-feu de la machine Docker | aucune règle entrante, aucune redirection de port |
| 12 | `docker compose … logs mcp-hub` | ni e-mail, ni jeton, ni identifiant d'annuaire |

## 8. En cas de problème

| Symptôme | Cause probable |
|---|---|
| Claude : « Couldn't connect » dès l'ajout | règle WAF trop stricte ou Bot Fight Mode : **Security → Events** de Cloudflare, chercher `/mcp` et `/register` |
| La page du hub s'affiche, l'annuaire simulé ne s'ouvre pas | navigateur sur une autre machine que Docker (§ 4.3, dernier paragraphe) |
| Microsoft : AADSTS50011 | URI de redirection différente de `https://mcp-proto.socle.si/oauth/callback/charlois` |
| Microsoft : AADSTS65001 | consentement administrateur non accordé (§ 5, étape 3) |
| Microsoft : AADSTS50105 | affectation requise et collaborateur hors du groupe pilote (voulu) |
| Page « Connexion impossible : la connexion avec … a échoué » | secret erroné ou expiré, ou ISSUER incorrect (journal du hub : `annuaire charlois : échec de la connexion (401)`) |
| Le hub ne démarre pas | message `[oauth-server]` explicite dans `logs mcp-hub` (variable manquante, ISSUER Entra sans ID d'annuaire…) |
| cloudflared ne se connecte pas | sortie 7844 bloquée par le pare-feu de la machine ou du réseau |
| Claude se déconnecte après quelques jours d'inactivité | normal au-delà de 30 jours (`OAUTH_SESSION_DAYS`) ; avant, consulter le journal (`compte désactivé`, `refresh token déjà utilisé`) |

## 9. Nettoyage

1. `docker compose -f docker-compose.proto.yml --env-file .env.proto down -v` (le `-v` efface le store du prototype :
   sessions, inscriptions, identités).
2. Cloudflare : supprimer le tunnel `clevoa-proto` (Zero Trust → Tunnels), l'enregistrement DNS `mcp-proto`, la règle WAF.
3. Claude : supprimer le connecteur (compte individuel et organisation).
4. Entra (Charlois et Oakwood) : supprimer l'inscription d'application ou au moins son secret.
5. Google : supprimer le client OAuth ou le projet `clevoa-proto`.
6. Supprimer `.env.proto` de la machine.

## 10. Prouvé, à prouver, limites

**Prouvé ici** (126 tests du hub, 13 du bouchon, dont 16 pour le prototype, et un parcours dans un vrai navigateur
Chromium) : parcours complet avec le client OAuth du SDK MCP qui se comporte comme Claude (découverte, inscription, PKCE,
`resource`) jusqu'à l'appel d'un outil ; trois annuaires dont un Google ; refus des comptes hors politique et des
id_token falsifiés (émetteur, audience, annuaire, nonce, expiration) ; liaison d'une identité à une seule clé ; rotation,
rejeu et révocation des jetons ; revalidation et coupure d'un compte désactivé ; tolérance d'une panne courte de
l'annuaire ; persistance après redémarrage ; cloisonnement du port public ; verrous de démarrage. Le fichier Compose est
validé par `docker compose config`.

**À prouver par toi** (impossible depuis mon environnement : ni Docker en fonctionnement, ni Cloudflare, ni Entra, ni
Google, ni Claude) : le tunnel réel, la règle WAF avec les adresses de Claude, l'inscription réelle de Claude auprès du
hub, le flux de bout en bout dans claude.ai et dans l'application de bureau, le comportement d'Entra (consentement,
affectation, MFA, désactivation) et de Google (`hd`, consentement).

**Limites assumées du prototype** :

* Sage X3 et MyReport seulement, en simulateur. Les connexions par application (Salesforce, SharePoint, Dropbox) restent
  sur le portail interne ; les enchaîner dans le même parcours est l'étape suivante.
* Une seule instance du hub ; jetons d'accès et codes en mémoire (un redémarrage force un renouvellement, sans reconnexion).
* Rejeu de refresh token strict : si une réponse de renouvellement se perd en route, le collaborateur doit se reconnecter.
* Inscription dynamique ouverte (bornée par la liste d'adresses de retour et un plafond de 500 clients) ; pas de CIMD, que
  le SDK ne gère pas encore côté serveur.
* Pas d'écran d'administration des sessions : la coupure passe par l'annuaire (désactivation) ou par l'effacement du store.
* Cloudflare voit les échanges en clair : à soumettre au DPO avant toute donnée réelle (alternative étudiée : relais frp,
  [étude § relais](connexion-un-clic.md)).
* Aucun test d'intrusion externe : obligatoire avant un service réel.
