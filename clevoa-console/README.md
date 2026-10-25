# Console de suivi Clevoa

Public : Clevoa (éditeur). Objet : suivre les installations Clevoa AI Gateway des clients (état, incidents, volumes,
erreurs, latence) à partir de la télémétrie reçue par le [backend](../clevoa-backend/README.md). Une page web servie par
un petit conteneur, à héberger sur un poste ou un NAS de Clevoa, **sur le réseau privé seulement**.

La console lit la table DynamoDB en lecture seule. Elle n'écrit rien, n'envoie rien aux hubs et n'a aucun accès aux
installations des clients : elle affiche ce que les hubs ont envoyé (compteurs, sans donnée métier ni identité).

| Zone | Contenu |
|---|---|
| Synthèse | installations suivies, en incident, silencieuses ; sièges ; appels de la dernière période |
| Installations | état (OK, incident, silencieuse, perdue), version (« ancienne » sous `MIN_VERSION`), dernier contact, sièges, appels, part d'erreurs et pire latence p95 de la dernière période de 6 heures |
| Détail d'une installation | incidents en cours en clair ; sur 30 jours : appels par période (réussis, erreurs du système, erreurs d'usage), taux d'erreur et latence p95 par connecteur, totaux par connecteur |

Les e-mails d'incident restent envoyés par le backend (ouverture et fermeture d'un incident seulement) : la console sert
à comprendre, pas à alerter.

## Essayer sans AWS

```bash
cd clevoa-console && npm install && npm run demo      # http://localhost:8090, trois installations fictives sur 30 jours
```

## Installer sur le NAS

1. **AWS, une fois** : après `serverless deploy` du backend, créer un utilisateur IAM `clevoa-console` sans accès à la
   console AWS, lui attacher la seule politique `clevoa-backend-prod-console-lecture` (créée par le déploiement :
   `Query`, `GetItem`, `DescribeTable` sur la table de télémétrie et son index), et créer une clé d'accès.
2. **NAS** : copier le dépôt (ou ce dossier et `clevoa-backend/handler.js` à leur place), puis dans `clevoa-console/` :

   ```bash
   cp .env.example .env        # renseigner la clé d'accès, le secret, le mot de passe de la console
   docker compose up -d --build
   ```

   Synology Container Manager ou QNAP Container Station : créer un projet à partir de ce `docker-compose.yml` et y
   saisir les mêmes variables.
3. Ouvrir `http://<adresse du NAS>:8090` ; le navigateur demande un mot de passe (`CONSOLE_PASSWORD`, identifiant libre).

Règles : ne jamais ouvrir le port 8090 sur internet (box, redirection de port, proxy inverse public) ; pour un accès
depuis l'extérieur, passer par le VPN du NAS. Le mot de passe passe en clair sur le réseau local (HTTP) : réseau de
confiance seulement, ou proxy inverse HTTPS du NAS devant la console. La clé AWS ne donne que la lecture de la table ;
si elle fuit, la désactiver dans IAM et en créer une autre.

## Variables

| Variable | Rôle |
|---|---|
| `TELEMETRY_TABLE`, `AWS_REGION` | table et région du backend (`clevoa-backend-prod-installations`, `eu-west-3`) |
| `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | utilisateur IAM en lecture seule |
| `CONSOLE_PASSWORD` | mot de passe de la page, obligatoire hors démonstration (la console refuse de démarrer sans) |
| `CONSOLE_PORT` | port publié (8090) |
| `MIN_VERSION`, `SILENCE_HOURS`, `SILENCE_HOURS_LEGACY`, `SILENCE_MAX_DAYS` | mêmes seuils que le backend, pour l'affichage |
| `CONSOLE_DEMO=1` | données de démonstration, sans AWS |

## Tester

```bash
cd clevoa-console && npm test     # 7 tests : mot de passe, lecture seule, requête mal formée, CSP, états, historique, entrées refusées
```
