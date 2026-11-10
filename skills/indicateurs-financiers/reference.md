# Référence technique des indicateurs (pour Claude)

Cette page sert à Claude ; l'intégrateur ou l'Owner l'adapte si l'instance diffère. Elle traduit chaque indicateur en
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

| Indicateur | Objet | Publiée par défaut | Filtres et calcul | Attention |
|---|---|---|---|---|
| Chiffre d'affaires | SINVOICE, ou écritures (GACCENTRY) | Non | Date comptable (ACCDAT) ; factures moins avoirs (SIVTYP) | Codes de SIVTYP et champ HT à confirmer avec `sagex3_describe` |
| Prises de commandes | SORDER | Oui | Date de commande (ORDDAT) | Préciser HT ou TTC ; montants d'en-tête à confirmer |
| Carnet de commandes | SORDER, lignes (`sagex3_get`) | Oui | Commandes ouvertes (ORDSTA), livraison incomplète (DLVSTA) | Champs de reste à confirmer ; au-delà de quelques commandes, renvoyer au classeur |
| Factures à établir | SDELIVERY | Non | Livraisons validées (CFMFLG) non facturées (INVFLG) | — |
| Exposition client | BPCUSTOMER, `sagex3_get`, facette `$details` | Oui | OST (Total en-cours), OSTAUZ (limite ; 0 = aucune limite saisie) | Le détail d'OST, dont le solde comptable, n'est pas exposé ; BPCRSK renseigné = encours suivi sur le client de risque ; BETFCY vrai = intragroupe |
| Encours comptable | Écritures (GACCENTRY) | Non | Comptes clients à date | Seule source d'un « encours » au sens comptable |
| Retards clients | GACCDUDATE | Non (absente du dictionnaire) | Échéances non lettrées échues | Sinon non calculable : le dire |
| Achats facturés | PINVOICE | Oui | Date comptable (ACCDAT) ; HT = TOTLINAMT ; avoirs = PIHTYP 3 et 4, à soustraire | Vérifier que TOTLINAMT et PIHTYP sont en colonnes de liste |
| Échéancier fournisseurs théorique | PINVOICE | Oui | Première échéance (DUDAT1) | Sans statut de règlement : ce ne sont pas des dettes réelles |
| Engagements d'achat | PORDER | Oui | Commandes signées (APPFLG) non soldées (CLEFLG) | — |
| Transformation des devis | SQUOTE | Non | Devis émis sur la période (QUODAT), statut (QUOSTA) | Pas de statut « perdu » : exclure les devis encore valides et dire combien |
| Pièces provisoires | PINVOICE.STA, SINVOICE.INVSTA, GACCENTRY.STA | Selon l'objet | Pièces non comptabilisées ou provisoires | À signaler dans toute revue |

## Salesforce

| Indicateur | Objet | Calcul |
|---|---|---|
| Pipeline brut | Opportunity | `SELECT SUM(Amount) … WHERE IsClosed = false GROUP BY StageName` ou `CALENDAR_MONTH(CloseDate)` |
| Pipeline pondéré | Opportunity | `SUM(ExpectedRevenue)` si le champ est lisible (`getObjectSchema`) ; sinon pas de pondéré, le dire |
| Transformation | Opportunity | Closes gagnées (IsWon) sur closes (IsClosed), même période de clôture (CloseDate) |
| Conversion des pistes | Lead | `SELECT COUNT()` avec IsConverted = true, puis sans ce filtre, même période (CreatedDate) |
| Activité commerciale | Task, Event | Task (ActivityDate, IsClosed), Event (StartDateTime), par OwnerId |

Une requête sans agrégat est plafonnée à 200 lignes : ne jamais additionner une liste plafonnée. Organisation
multidevise : dire la devise des totaux.

## Classeurs du contrôle de gestion

Quand un classeur fait foi, Claude le lit sur Dropbox ou SharePoint. Si la lecture signale des classeurs liés, les
valeurs datent de la dernière ouverture du fichier : Claude donne cette date et prévient que les chiffres peuvent être
décalés.
