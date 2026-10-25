# Clevoa backend (AWS Lambda)

Public : Clevoa (éditeur). Objet : recevoir la télémétrie des hubs Clevoa AI Gateway (toutes les 6 heures), tenir une
fiche et un historique par installation, et prévenir Clevoa par e-mail **seulement** quand un incident s'ouvre ou se
ferme chez un client. Le suivi au quotidien se fait dans la [console](../clevoa-console/README.md), en lecture seule. Données envoyées par le hub, finalité et
conservation : [sécurité § 4](../docs/admin/securite.md#4-télémétrie-clevoa).

| Élément | Rôle |
|---|---|
| `POST /api/v1/telemetry` (fonction `telemetry`) | vérifie `X-Clevoa-Key`, valide le payload (champs connus seulement, statistiques bornées, 8 Ko au plus), ajoute ou réécrit la ligne d'historique de la période, ouvre ou ferme les incidents d'erreurs, met à jour la fiche de l'installation, répond `{"status":"active"}` et, s'ils sont configurés, `minimum` et `latest` |
| Fonction `report`, chaque heure à HH:07 UTC | ouvre l'incident « silence » d'une installation muette ; renvoie un e-mail d'incident qui n'avait pas pu partir ; au-delà de `SILENCE_MAX_DAYS` (30 jours), l'installation est « perdue » : listée, sans e-mail ; liste aussi les versions sous `MIN_VERSION` (visibles dans la console, sans e-mail). Chaque changement est une mise à jour conditionnelle : un contact du hub ou un second passage simultané l'emporte, sans double e-mail |
| Table DynamoDB `clevoa-backend-<stage>-installations` | clé `pk` = `client#installation#environnement`, `sk` = `ETAT` pour la fiche (version, cadence d'envoi, connecteurs déclarés, sièges, premier et dernier contact, incidents en cours et déjà annoncés, statistiques du dernier envoi) ou `P#<début de période>` pour une ligne d'historique (statistiques d'une période de 6 h ; un envoi répété de la même période réécrit sa ligne) ; compteur d'e-mails par client et par heure (`<client>#alertes`) ; index creux `etats` sur les seules fiches ; chaque ligne expire `RETENTION_DAYS` (400) jours après son écriture |
| Sujet SNS `clevoa-backend-<stage>-alertes` | e-mails d'incident, abonnement créé une fois à la main |
| Politique IAM `clevoa-backend-<stage>-console-lecture` | `Query`, `GetItem`, `DescribeTable` sur la table et son index `etats`, rien d'autre : à attacher à l'utilisateur IAM de la console |

**Incidents**, ouverts sur chaque envoi (la dernière période de 6 heures) et par connecteur :

| Incident | Condition (variable, valeur par défaut) |
|---|---|
| `auth:<connecteur>` | tous les collaborateurs qui ont appelé l'outil ont été refusés en authentification sans être servis une seule fois sur la période, à partir de `AUTH_MIN_USERS` (2) collaborateurs : application OAuth, secret ou mot de passe à vérifier chez le client |
| `erreurs:<connecteur>` | plus de `ERROR_RATE` (20 %) d'erreurs du système (délai, système injoignable, quota, authentification, autre) sur au moins `ERROR_MIN_CALLS` (10) appels ; les erreurs d'usage (outil hors liste blanche, compte non connecté) ne comptent pas |
| `silence` | aucun contact depuis `SILENCE_HOURS` (14 h, deux envois manqués) ; `SILENCE_HOURS_LEGACY` (50 h) pour un hub antérieur à la 1.3.2-rc.2, qui n'envoie qu'une fois par jour |

Un incident d'erreurs ne se ferme que sur preuve : au moins `ERROR_MIN_CALLS` appels avec un taux normal, ou un
collaborateur authentifié. Une période creuse (nuit, week-end, redémarrage du hub) le laisse ouvert ; « silence » se
ferme au premier contact. Un connecteur que le hub ne déclare pas configuré (retiré, ou simulateur) n'ouvre aucun
incident et ferme le sien. Un hub antérieur à la 1.3.2-rc.2 n'envoie pas de statistiques : seul l'incident « silence »
le concerne.

Un e-mail part à l'ouverture d'un incident (« Clevoa AI Gateway : incident chez <client> », avec la cause en clair) et
un autre à sa fermeture (« rétabli chez <client> ») ; rien tant que l'incident dure, rien pour une version ancienne.
La fiche retient ce qui a été annoncé : un e-mail en échec (SNS indisponible) est retenté au contact suivant ou au
passage horaire. Un e-mail parti n'est pas renvoyé, sauf si l'enregistrement de la fiche échoue juste après l'envoi
(le hub renvoie alors sa période et l'e-mail repart : un double, jamais un oubli). Au plus `ALERT_MAX_PER_HOUR` (10)
e-mails par client et par heure : le dernier est suivi d'un avertissement « trop d'alertes », les suivants sont
reportés à l'heure suivante. L'état est écrit à condition de ne pas avoir changé depuis sa lecture : un contact du hub
et un passage horaire simultanés n'effacent ni un incident ni un « rétabli ».

Aucune dépendance à installer : le SDK AWS (DynamoDB, SNS) est fourni par le runtime Lambda Node 22. Sans
`TELEMETRY_TABLE` (tests, poste local), les fiches sont gardées en mémoire. `CLEVOA_KEYS` liste des entrées
`client=clé` (nom en minuscules, chiffres et tirets) ; une entrée sans nom est ignorée. La clé n'est jamais stockée ni
journalisée : la fiche porte le nom du client.

Conservation : fiche et lignes d'historique expirées 400 jours après leur écriture (suppression par AWS en général sous
quelques jours ; environ 1 460 lignes par installation et par an), copie de restauration à un instant donné gardée
35 jours, journaux CloudWatch 90 jours, e-mails d'incident selon la politique de la messagerie de Clevoa.

## Déployer (Clevoa, compte AWS existant)

Commandes non exécutées dans le cadre de la stabilisation d'octobre 2026 (aucun déploiement AWS réel) : syntaxe à
confirmer au premier déploiement.

```bash
npm i -g serverless            # Serverless Framework v4
aws configure                  # identifiants IAM avec droits CloudFormation, Lambda, API Gateway, IAM, DynamoDB, SNS, CloudWatch
cd clevoa-backend
CLEVOA_KEYS="charlois=<clé-charlois-prod>" MIN_VERSION=1.3.1 serverless deploy --stage prod   # affiche l'URL de l'API
aws sns subscribe --topic-arn <arn du sujet clevoa-backend-prod-alertes> --protocol email --notification-endpoint <adresse Clevoa>
```

Le schéma de clé de la table a changé en 1.3.2-rc.2 (`pk`, `sk` au lieu de `id`) : une table créée par une version
précédente du backend ne peut pas être modifiée en place. Si une pile a déjà été déployée, la retirer
(`serverless remove`, qui supprime la table et ses fiches) avant de redéployer.

Console : créer un utilisateur IAM sans accès à la console AWS, lui attacher la seule politique
`clevoa-backend-prod-console-lecture` et lui créer une clé d'accès ([console](../clevoa-console/README.md)).

Une clé par client et par environnement est recommandée (`charlois-preprod=…,charlois=…`). Une sauvegarde de production
restaurée en pré-production y apporte le même identifiant d'installation : l'environnement fait partie de la fiche,
les deux restent distinctes. Ajouter un client = redéployer avec la
nouvelle liste. La production des hubs envoie à `https://clevoa.fr/api/v1/telemetry` : nom de domaine personnalisé
API Gateway, certificat ACM et enregistrement DNS à créer une fois.

## Exploiter

```bash
serverless invoke -f report --stage prod      # rapport à la demande (JSON : total, silencieuses, perdues, obsolètes, incidents)
serverless logs -f telemetry --stage prod --tail
serverless deploy --stage prod                # après changement de MIN_VERSION, LATEST_VERSION ou CLEVOA_KEYS
```

Une installation silencieuse n'est pas forcément en panne : hub arrêté, flux sortant bloqué par le client, clé
retirée. Le contact passe par l'administrateur du client ; Clevoa n'a aucun accès à l'installation.

Fiches qui ne seront plus mises à jour, à retirer une fois le cas compris : `client#ancienne#<env>` laissée par un hub
antérieur à 1.3.2 après sa mise à jour, ancienne fiche d'une installation réinstallée (volume perdu, sauvegarde antérieure
à l'identifiant), fiche d'une version 1.3.2 après un retour arrière vers 1.3.1 (puis de nouveau active à la remise à niveau).
Elles passent d'elles-mêmes en « perdues » après 30 jours, et expirent après 400 jours (leurs lignes d'historique aussi).
Retrait immédiat de la fiche :

```bash
aws dynamodb delete-item --table-name clevoa-backend-prod-installations --key '{"pk":{"S":"<client>#<identifiant>#<ENV>"},"sk":{"S":"ETAT"}}'
```

Limites connues, à reprendre au premier déploiement : les deux fonctions partagent un rôle IAM ; le débit de l'API est
plafonné à 2 requêtes par seconde (rafale de 10) par une extension de l'étape `HttpApiStage` dont la prise en compte est
à vérifier dans la console API Gateway après le premier déploiement ; une clé divulguée permet encore de créer des
fiches dans ce débit (à révoquer en la retirant de `CLEVOA_KEYS`) ; `reservedConcurrency: 5` exige un compte AWS dont
le quota dépasse 10 exécutions simultanées (les hubs étalent leurs envois sur 10 minutes après chaque créneau).

Retirer la pile : `serverless remove --stage <stage>` supprime aussi la table et l'historique des contacts.

## Tester sans AWS

```bash
cd clevoa-backend && npm test     # 21 tests : clés, validation, fiche et historique, incidents, e-mails, silence, passages concurrents, plafond, adaptateur DynamoDB
```
