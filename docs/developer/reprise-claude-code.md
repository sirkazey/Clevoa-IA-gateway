# Reprendre le projet dans Claude Code

Public : le propriétaire du produit, ou toute personne qui reprend le développement avec Claude Code (claude.ai/code).
Objet : recréer en cinq minutes, sur un autre compte Claude, l'environnement cloud, la session et le contexte de
travail. Les règles permanentes sont dans [`CLAUDE.md`](../../CLAUDE.md), chargé automatiquement par chaque session.

## 1. Procédure en cinq minutes

1. **GitHub.** Sur le nouveau compte : connecter GitHub (https://claude.ai/connect-github), puis vérifier que l'application
   Claude GitHub est installée sur `sirkazey/Clevoa-IA-gateway` (même page). Sans elle, la session ne peut ni cloner ni
   ouvrir de PR.
2. **Environnement cloud.** Sur claude.ai/code, créer un environnement nommé `MCP-Finance` :
   * *Network access* : **Trusted** (par défaut) ; il autorise déjà `nodejs.org` et npm ;
   * *Setup script* : coller le script ci-dessous. Il installe Node 24 sans dépendre du dépôt, puis les dépendances si
     le dépôt est déjà cloné, et sort toujours en code 0 (un code non nul empêche la session de démarrer) ;
   * aucune variable ni secret : les tests tournent sans réseau ni compte réel.

   ```bash
   #!/bin/bash
   # Clevoa AI Gateway : Node 24 (l'image fournit Node 22), puis dépendances si le dépôt est déjà cloné. Toujours code 0.
   V=24.22.1
   if ! /opt/node24/bin/node --version 2>/dev/null | grep -qx "v$V"; then
     mkdir -p /opt/node24 && curl -sSfL "https://nodejs.org/dist/v$V/node-v$V-linux-x64.tar.xz" | tar -xJ -C /opt/node24 --strip-components=1
   fi
   mkdir -p "$HOME/.local/bin" && ln -sf /opt/node24/bin/node /opt/node24/bin/npm /opt/node24/bin/npx "$HOME/.local/bin/"
   for d in */; do [ -f "$d/ops/claude-setup.sh" ] && bash "$d/ops/claude-setup.sh"; done
   true
   ```
3. **Session.** Nouvelle session dans cet environnement, **dépôt `sirkazey/Clevoa-IA-gateway` sélectionné avant le
   premier message** (sinon le dépôt n'est pas cloné : « Cloner le dépôt » apparaît grisé), branche `dev`, modèle le plus
   capable proposé, mode de permission *auto*.
4. **Contexte.** Coller le prompt du § 2 comme premier message.
5. **Vérification.** La session doit répondre avec la version courante, l'état de `main` et `dev`, et le résultat
   des tests du hub. Si Node 22 apparaît ou si les dépendances manquent, lancer `bash ops/claude-setup.sh` dans la session.

Facultatif, selon le travail : reconnecter Google Drive (contrats et documents Clevoa), Microsoft Learn (documentation
Entra ID), et recopier les préférences personnelles (§ 3).

## 2. Prompt de reprise

```text
Tu reprends le projet Clevoa AI Gateway sur un nouveau compte. Lis CLAUDE.md, puis
docs/developer/reprise-claude-code.md (§ 4 à 6), docs/validation/etat-des-fonctionnalites.md et le haut de CHANGELOG.md.
Ensuite, sans rien modifier :
1. donne la version courante, le dernier commit de main et de dev, et les PR ouvertes ;
2. lance les tests du hub (pré-production et production) et node ops/check-docs.js ;
3. liste les travaux en attente du § 6 de la doc de reprise, avec ce que tu proposes de faire en premier.
Réponds en français, en conseiller : conclusion d'abord, incertitudes signalées.
```

## 3. Préférences personnelles du propriétaire

À recopier dans les réglages du profil Claude (préférences de réponse), elles ne suivent pas le compte :

```text
Tu es mon conseiller, pas mon assistant. ton rôle est d'être utile, pas agréable.Applique ces règles dans chaque réponse:
1. Va droit au but. Pas d'introduction. Ta première phrase est la chose la plus utile que tu puisses dire.
2: Dis quand tu ne sais pas. Si tu n'es pas certain, dis-le clairement: "Je ne suis pas sûr de cela" ou "Tu devrais vérifier cette information". Ne comble jamais les lacunes avec des suppositions formulées avec assurance.
3: Signale ce qui doit être vérifié. Si une affirmation repose sur des données récentes ou des faits que tu ne peux pas confirmer, dis: "Vérifie ca avant d'agir".
4: Exprime ton désaccord directement. Si j'ai tort: dis pourquoi, propose une alternative, nomme le risque. Sans l'adoucir.
5: tiens ta position. Si je conteste sans apporter de nouveaux arguments, ne change pas ta réponse. "Mais j'en suis convaincu" n'est pas une raison de réviser.
6: Avant de répondre, détaille brièvement les étapes de ton analyse, structure tes raisonnements afant de donner la réponse finale.
7: N'utilise jamais: "Bonne question", "Tu as tout à fait raison", "C'est très pertinent", "Absolument", "Bien sûr", "Effectivement".
```

## 4. Environnement : ce que la session trouve et ce qu'elle n'a pas

| Élément | État | Remarque |
|---|---|---|
| Node | 22 fourni par l'image ; 24.22.1 installé par [`ops/claude-setup.sh`](../../ops/claude-setup.sh) dans `/opt/node24` | liens dans `~/.local/bin`, prioritaire dans le PATH ; vérifié le 3 novembre 2026 (environ 10 s) |
| Docker | client présent, démon arrêté | `nohup dockerd >/tmp/dockerd.log 2>&1 &` démarre le démon (vérifié) ; téléchargement d'images depuis Docker Hub non vérifié |
| GitHub | outils MCP GitHub de la session (lecture, PR, fusion, relance de CI) | pas de CLI `gh` ; push des tags et suppression de branches refusés (403) : à faire dans l'interface |
| Réseau | proxy sortant de la session | aucun appel aux systèmes réels (Sage, Salesforce, Entra) depuis le cloud : les tests réels se font depuis le poste du propriétaire |
| Durée de vie | conteneur effacé après inactivité | tout ce qui compte est poussé sur GitHub ; les fichiers du *scratchpad* sont perdus |

Hook de fin de tour de l'environnement : il rappelle de commiter et pousser toute modification en cours. Le respecter,
sauf travail d'un sous-agent non terminé.

## 5. Agents, skills et connecteurs

**Agents.** Le dépôt ne définit aucun agent personnalisé (pas de `.claude/agents/`). Les sessions ont utilisé les
sous-agents intégrés (`general-purpose`, `Explore`) avec des consignes écrites au cas par cas. Trois usages éprouvés,
à reprendre :

| Usage | Comment |
|---|---|
| Audit complet | trois sous-agents en parallèle, en lecture seule : documentation ; code du hub ; scripts, CI, bouchon et console. Chacun rend une liste de constats avec fichier et ligne ; la session principale corrige |
| Relecture indépendante avant fusion | un sous-agent qui reçoit le diff, pas la conclusion de la session, et cherche les défauts de sécurité et de fonctionnement |
| Corrections de documentation en masse | un sous-agent avec la liste numérotée des corrections, interdiction de toucher au code, `node ops/check-docs.js` et `hub/test/docs.test.js` à passer, compte rendu point par point |

**Skills.** Aucune skill propre au projet. Skills intégrées utiles : `code-review` et `security-review` (relecture d'un
diff), `session-start-hook` (si l'on veut remplacer le script d'environnement par un hook versionné).

**Connecteurs claude.ai** (à reconnecter sur le nouveau compte) :

| Connecteur | Usage | Indispensable |
|---|---|---|
| GitHub | dépôt, PR, CI, alertes CodeQL | oui |
| Google Drive | contrats et documents Clevoa du propriétaire | non |
| Microsoft Learn | documentation Entra ID, Graph | non |
| Artifacts | rapports et écrans publiés | non |

**Ce qui ne se transfère pas d'un compte à l'autre** : l'historique des conversations, les artifacts publiés, les
routines programmées, les connexions des connecteurs, les préférences et la mémoire. Les artifacts de l'ancien compte
(écrans du portail, rapport SSO) sont à exporter avant sa fermeture si on veut les garder ; leur contenu de référence
est déjà dans [`docs/validation/`](../validation/etat-des-fonctionnalites.md).

## 6. État au 5 novembre 2026

* `main` : version **1.7.0-rc.1** (accès en ligne pour Claude, expérimental), tag `v1.7.0-rc.1` posé ; `dev` réaligné.
* Pré-production sur le serveur du client depuis le 05/11 : Portainer, reverse-proxy nginx existant, Sage X3 (CHREC),
  Salesforce sandbox, SharePoint et SSO Entra réels, Claude Desktop vérifié ([journal P1–P11](../validation/journal-tests-reels.md)).
  `PIHTYP` lu sur CHREC ; `SINVOICE`, `GACCENTRY`, `GACCDUDATE` absents en standard (développement spécifique à chiffrer).
* Accès en ligne en cours de mise en place : serveurs DNS de `clevoa.fr` changés pour Cloudflare le 05/11 (publication par le registre en cours), tunnel `charlois-test`
  créé, application Entra du portail complétée (scope `mcp`, jetons v2, consentement administrateur) ; reste la route du
  tunnel, les règles WAF, `docker-compose.online.yml` dans la stack et l'ajout du connecteur par l'Owner Claude.
* Recette réelle restante avant toute production : [état des fonctionnalités § 3](../validation/etat-des-fonctionnalites.md#3-tests-restant-à-réaliser),
  en premier le cloisonnement avec un compte non administrateur.

Travaux en attente, dans l'ordre proposé :

1. Accès en ligne : finir la mise en place ([guide](../admin/acces-en-ligne.md), [runbook Cloudflare](../admin/cloudflare.md))
   et faire le premier essai réel (claude.ai, application de bureau, mobile).
2. Petits correctifs constatés le 05/11 : bouchon aligné sur le vrai PINVOICE (statut de règlement retiré, `PIHTYP`
   ajouté) ; raison du refus silencieux de SharePoint journalisée ; libellé « jeton personnel » de Sage au portail.
3. Décision du propriétaire : alléger le dépôt pour un client unique (télémétrie, backend AWS et console ; connecteurs
   Dropbox et MyReport) : à reprendre après la recette réelle ; télémétrie envisagée sur Cloudflare (Workers et D1).
4. Côté GitHub, à faire par le propriétaire : supprimer les branches déjà fusionnées, poser les rulesets de `main`,
   `dev` et des tags `v*`.
