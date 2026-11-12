# Référence technique des indicateurs (pour Claude)

Cette page sert à Claude ; l'intégrateur ou l'administrateur Claude l'adapte si l'instance diffère. Elle traduit chaque indicateur en
objets, champs et outils.

## Avant toute lecture

1. `sagex3_representations` : la représentation est-elle publiée ? Absente = le dire, ne rien estimer.
2. `clevoa_dictionnaire` puis `sagex3_describe` : les champs existent-ils sur l'instance ?
3. Sage X3 : `sagex3_query` renvoie les colonnes de liste ; `sagex3_get` lit une fiche et sa facette `$details`
   (exemple : OST, OSTAUZ). Un total n'est possible que si le montant figure dans les colonnes de liste et que la liste
   est complète.
4. Salesforce : `salesforce_tools`, puis `salesforce_call` avec `getObjectSchema` (champs) ou `soqlQuery` (agrégats
   `SUM`, `COUNT`).

Sage X3 n'a pas d'agrégat dans l'API. Les totaux se calculent avec l'exécution de code si elle est disponible, sinon en
montrant l'addition ; jamais sur une liste tronquée.

## Sage X3

| Indicateur | Objet | Publiée par défaut (vérifier avec `sagex3_representations`) | Filtres et calcul | Attention |
|---|---|---|---|---|
| Chiffre d'affaires | SINVOICE, ou balance (BALANCE) | Non | Date comptable (ACCDAT) ; HT = AMTNOT, TTC = AMTATI ; facture ou avoir = INVTYP (menu local 645) ; statut STA | Noms tirés du modèle de données Sage : confirmer avec `sagex3_describe` |
| Prises de commandes | SORDER | Oui | Date de commande (ORDDAT) | Préciser HT ou TTC ; montants d'en-tête à confirmer |
| Carnet de commandes | SORDER, lignes (`sagex3_get`) | Oui | Commandes ouvertes (ORDSTA), livraison incomplète (DLVSTA) ; reste à livrer en table SORDERQ (QTY, DLVQTY, TDLQTY) | Champs de reste à confirmer dans la représentation ; au-delà de quelques commandes, renvoyer au classeur |
| Factures à établir | SDELIVERY | Non | Livraisons validées (CFMFLG) non facturées (INVFLG) | — |
| Exposition client | BPCUSTOMER, `sagex3_get`, facette `$details` | Oui | OST (Total en-cours), OSTAUZ (limite ; 0 = aucune limite saisie) | Le détail d'OST, dont le solde comptable, n'est pas exposé ; BPCRSK renseigné = encours suivi sur le client de risque ; BETFCY vrai = intragroupe |
| Encours comptable | Composante « solde comptable » de l'encours (table BPCUSTMVT, champs BLC*) si l'intégrateur l'expose ; sinon balance (BALANCE) | Non | Comptes clients à date | Seule source d'un « encours » au sens comptable |
| Retards clients | GACCDUDATE | Non (absente du dictionnaire) | Échéance DUDDAT passée, montant AMTCUR moins réglé PAYCUR, échéance non soldée (FLGCLE, valeurs à confirmer), sens SNS | Sinon non calculable : le dire |
| Achats facturés | PINVOICE | Oui | Date comptable (ACCDAT) ; HT = TOTLINAMT ; avoirs = PIHTYP 3 et 4, à soustraire | TOTLINAMT doit être en colonne de liste, sinon pas de total : le dire et demander l'ajout à la facette $query ; PIHTYP est filtrable dans where |
| Échéancier fournisseurs théorique | PINVOICE | Oui | Première échéance (DUDAT1) | Sans statut de règlement : ce ne sont pas des dettes réelles |
| Engagements d'achat | PORDER | Oui | Commandes signées (APPFLG) non soldées (CLEFLG) | — |
| Transformation des devis | SQUOTE | Non | Devis émis sur la période (QUODAT), statut (QUOSTA) | Statut « perdu » pas toujours saisi ; devis encore valides = date de validité (VLYDAT) postérieure à la lecture : les exclure et dire combien |
| Pièces provisoires | PINVOICE.STA (1 en attente, 2 à valider, 3 validée), SINVOICE.STA, GACCENTRY.STA (1 provisoire, 2 définitive) | Selon l'objet | Pièces non validées ou provisoires ; écritures : ne garder que CAT = 1 (réel), sinon simulations et modèles sont inclus | À signaler dans toute revue |

## Salesforce

| Indicateur | Objet | Calcul |
|---|---|---|
| Pipeline brut | Opportunity | `SELECT SUM(Amount) … WHERE IsClosed = false GROUP BY StageName` ou `CALENDAR_MONTH(CloseDate)` |
| Pipeline pondéré | Opportunity | `SUM(ExpectedRevenue)` si le champ est lisible (`getObjectSchema`) ; sinon pas de pondéré, le dire |
| Taux de gain des opportunités (≠ devis) | Opportunity | Closes gagnées (IsWon) sur closes (IsClosed), même période de clôture (CloseDate) |
| Conversion des pistes | Lead | `SELECT COUNT()` avec IsConverted = true, puis sans ce filtre, même période (CreatedDate) |
| Activité commerciale | Task, Event | Task (ActivityDate, IsClosed), Event (StartDateTime), par OwnerId |

Une requête sans agrégat est plafonnée à 200 lignes : ne jamais additionner une liste plafonnée. Organisation
multidevise : dire la devise des totaux.

## Classeurs du contrôle de gestion

Quand un classeur fait foi, Claude le lit sur Dropbox ou SharePoint. Si la lecture signale des classeurs liés, les
valeurs viennent du dernier calcul du fichier : Claude donne la date de modification du classeur (seule date connue),
cite les classeurs liés et prévient qu'il ne sait pas s'ils ont changé depuis.
