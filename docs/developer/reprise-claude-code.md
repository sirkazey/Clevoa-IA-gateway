# Reprendre le projet dans Claude Code

Public : le propriétaire du produit, ou quiconque reprend le développement avec Claude Code (claude.ai/code).
Objet : recréer en cinq minutes, sur un autre compte Claude, l'environnement cloud, la session et le contexte. Les
règles permanentes sont dans [`CLAUDE.md`](../../CLAUDE.md), chargé par chaque session.

## 1. Procédure en cinq minutes

1. **GitHub.** Connecter GitHub (https://claude.ai/connect-github) et vérifier que l'application Claude GitHub est
   installée sur `sirkazey/Clevoa-IA-gateway`. Sans elle, la session ne peut ni cloner ni ouvrir de PR.
2. **Environnement cloud.** Sur claude.ai/code, créer un environnement `MCP-Finance` :
   * *Network access* : **Trusted** (autorise `nodejs.org` et npm) ;
   * *Setup script* : le script ci-dessous. Il installe Node 24, puis les dépendances si le dépôt est cloné. Il sort
     toujours en code 0 : un code non nul empêche la session de démarrer ;
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
3. **Session.** Nouvelle session dans cet environnement. Sélectionner le dépôt `sirkazey/Clevoa-IA-gateway` **avant le
   premier message**, sinon il n'est pas cloné. Branche `dev`, modèle le plus capable, mode de permission *auto*.
4. **Contexte.** Coller le prompt du § 2 comme premier message.
5. **Vérification.** La session répond avec la version courante, l'état de `main` et `dev` et le résultat des tests du
   hub. Si Node 22 apparaît ou si les dépendances manquent : `bash ops/claude-setup.sh`.

Facultatif : reconnecter Google Drive et Microsoft Learn (§ 5), recopier les préférences (§ 3).

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

À recopier dans les préférences du profil Claude ; elles ne suivent pas le compte :

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

## 4. Environnement de la session

| Élément | État |
|---|---|
| Node | 22 dans l'image ; 24.22.1 installé par [`ops/claude-setup.sh`](../../ops/claude-setup.sh) dans `/opt/node24` |
| Docker | démon arrêté : `nohup dockerd >/tmp/dockerd.log 2>&1 &` ; téléchargement depuis Docker Hub non vérifié |
| GitHub | lecture, PR, fusion, CI ; tags, Releases et suppression de branches refusés (403) : à faire dans l'interface |
| Réseau | aucun appel aux systèmes réels depuis le cloud ; les tests réels se font depuis le poste du propriétaire |
| Durée de vie | conteneur effacé après inactivité : pousser tout ce qui compte (un hook de fin de tour le rappelle) |

## 5. Agents, skills et connecteurs

Aucun agent ni skill propre au dépôt. Usages éprouvés des sous-agents intégrés : audit en trois sous-agents en lecture
seule (documentation ; code du hub ; scripts, CI, bouchon et console) ; relecture d'un diff avant fusion par un
sous-agent qui ignore la conclusion de la session. Skills utiles : `code-review`, `security-review`.

Connecteurs claude.ai : GitHub (indispensable) ; Google Drive, Microsoft Learn, Artifacts (facultatifs). Ne passent
pas d'un compte à l'autre : conversations, artifacts, tâches programmées, connexions, préférences et mémoire.

## 6. État et travaux en attente

État au 6 novembre 2026 : `main` et `dev` en **1.7.0-rc.7** (tag `v1.7.0-rc.7` à poser par le propriétaire ; `v1.7.0-rc.5` déployée le 06/11). Pré-production sur le
serveur du client depuis le 05/11 ([journal P1–P11](../validation/journal-tests-reels.md)). Recette réelle restante :
[état des fonctionnalités § 3](../validation/etat-des-fonctionnalites.md#3-tests-restant-à-réaliser), en premier le
cloisonnement avec un compte non administrateur.

Travaux en attente, dans l'ordre proposé :

1. Accès en ligne : finir la mise en place (route du tunnel, règles WAF, variables `CLOUDFLARE_*` et
   `ENTRAID_CLAUDE_*`, connecteur ajouté par l'Owner Claude ; état exact à vérifier), puis premier essai réel
   ([guide](../admin/acces-en-ligne.md), [runbook Cloudflare](../admin/cloudflare.md)).
2. Petits correctifs : bouchon aligné sur le vrai `PINVOICE` (`PIHTYP` ajouté, statut de règlement retiré) ; raison du
   refus silencieux de SharePoint journalisée ; libellé « jeton personnel » de Sage au portail.
3. Après la recette, décision du propriétaire : alléger le dépôt pour un client unique (télémétrie, backend AWS,
   console ; Dropbox et MyReport).
4. Par le propriétaire, sur GitHub : supprimer les branches fusionnées, poser les rulesets de `main`, `dev` et `v*`.
