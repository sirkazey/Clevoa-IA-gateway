# Démarrage rapide : vos applications dans Claude

Public : le collaborateur, le premier jour. Objet : les étapes, dans l'ordre, pour interroger Sage X3, Salesforce,
SharePoint et Dropbox depuis Claude, avec vos droits et en lecture seule. Le détail est dans le [guide utilisateur](guide-utilisateur.md).

Votre service informatique vous donne deux choses : **l'adresse du portail** et le **nom du connecteur** dans Claude
(par exemple « Clevoa – <entreprise> »).

## Étape 1 : connecter vos applications (une seule fois, au bureau ou par le VPN)

1. Ouvrez **l'adresse du portail** dans votre navigateur. Votre compte Microsoft vous reconnaît automatiquement.
2. Dans **Vos applications**, cliquez **Se connecter** sur chaque ligne et acceptez la demande d'autorisation :
   * **Salesforce** et **Dropbox** : page de l'éditeur, puis **Autoriser** ;
   * **Sage X3** : votre identifiant et votre mot de passe Sage ;
   * **SharePoint** : rien à faire, il se connecte tout seul.
3. Cliquez **Tout tester** : chaque ligne doit afficher « Accès vérifié » en vert.

## Étape 2 : activer le connecteur dans Claude (une seule fois)

1. Dans Claude (claude.ai, application de bureau ou téléphone) : **Paramètres → Connecteurs**.
2. Sur le connecteur **Clevoa**, cliquez **Connecter**, puis choisissez votre compte Microsoft professionnel.
3. C'est tout : le connecteur vous suit sur le web, l'ordinateur et le téléphone.

## Étape 3 : poser vos questions

1. Ouvrez une nouvelle conversation. Avec le bouton **+**, vérifiez que le connecteur Clevoa est activé.
2. Posez votre question en français, par exemple :
   * « Quelles sont les commandes du client X ce mois-ci dans Sage ? »
   * « Résume le contrat Y dans mon Dropbox. »
   * « Trouve la dernière version du budget sur SharePoint et donne-moi les totaux par service. »
3. Claude demande parfois l'autorisation d'utiliser un outil : choisissez **Toujours autoriser**. Tous les outils sont
   en lecture seule ; rien ne peut être modifié ni supprimé.
4. Chaque réponse se termine par **« Source : … »** : vérifiez d'où vient le chiffre avant de l'utiliser.

## En cas de souci

| Ce que vous voyez | Que faire |
|---|---|
| Claude vous donne un lien « Action requise : se connecter » | Ouvrez le lien (au bureau ou par le VPN), connectez l'application, reposez la question |
| Vous ne savez pas avec quel compte vous êtes connecté | Demandez à Claude : « Avec quel compte suis-je connecté ? » |
| Le connecteur Clevoa n'apparaît pas dans Claude | Prévenez le service informatique |
| Votre mot de passe Sage a changé | Portail → ligne Sage X3 → **Reconnecter** |
| Un document récent n'est pas trouvé | Donnez à Claude le dossier où il se trouve : la recherche peut avoir quelques heures de retard |

## Trois règles

* Ne collez jamais un mot de passe dans une conversation.
* Vérifiez toujours un chiffre important dans l'application d'origine : Claude peut se tromper.
* Vous ne voyez que ce que vous voyez déjà dans vos applications : rien de plus.
