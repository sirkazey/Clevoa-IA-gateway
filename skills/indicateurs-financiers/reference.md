# Référence technique des indicateurs (pour Claude)

Cette page sert à Claude, pas au lecteur métier. Elle traduit chaque indicateur en objets et champs. Avant de s'appuyer
sur un champ, Claude vérifie qu'il existe sur l'instance avec l'outil `clevoa_dictionnaire` (objets, champs, pièges de
lecture) puis `sagex3_describe` ou `getObjectSchema`. Si une représentation manque, il le dit au lieu de deviner.

## Sage X3

| Indicateur | Objet qui fait foi | Filtres et calcul | Attention |
|---|---|---|---|
| Chiffre d'affaires | Balance comptable ; SINVOICE pour le détail | Date comptable (ACCDAT) ; factures moins avoirs (SIVTYP) ; montant HT | Montants non signés : soustraire les avoirs |
| Prises de commandes | SORDER | Date de commande (ORDDAT) dans la période | Préciser HT ou TTC |
| Carnet de commandes | SORDER (lignes) | Commandes ouvertes (ORDSTA) dont livraison ou facturation incomplète (DLVSTA, INVSTA) | Raisonner sur les lignes, pas sur le total |
| Factures à établir | SDELIVERY | Livraisons validées (CFMFLG) non facturées (INVFLG) | Représentation pas toujours publiée |
| Encours client | Balance (comptes clients) ou composante « solde comptable » de BPCUSTOMER | À défaut : OST de BPCUSTOMER (facette $details), à présenter comme exposition totale | OST inclut commandes et livraisons non facturées ; OSTAUZ à 0 = aucune limite saisie ; BETFCY vrai = intragroupe |
| Retards clients | GACCDUDATE (échéances) | Échéances non lettrées dont la date est passée | Sans lettrage : estimation, le dire |
| Achats | PINVOICE ; balance (comptes de charges) | Date comptable (ACCDAT) ; HT = TOTLINAMT ; avoirs = PIHTYP 3 et 4 | Soustraire les avoirs |
| Dettes fournisseurs | Balance (comptes fournisseurs) ; GACCDUDATE | Solde à date ; échéances (DUDAT1) | — |
| Engagements d'achat | PORDER | Commandes signées (APPFLG) non soldées (CLEFLG) | — |
| BFR | Balance comptable | Soldes stocks, clients, fournisseurs à la même date | Souvent suivi dans un classeur du contrôle de gestion : le préférer s'il fait foi |
| DSO | Balance + CA | Encours à date et CA TTC des derniers mois, même périmètre | Méthode fixée par le contrôle de gestion |
| Taux de transformation des devis | SQUOTE | Devis de la période (QUODAT) et leur statut (QUOSTA) | Exclure les devis encore valides, ou le dire |

Sage X3 n'a pas d'agrégat dans l'API : un total ne s'additionne que sur une liste complète (sans avertissement de liste
tronquée). Sinon, découper la période ou utiliser la balance.

## Salesforce

| Indicateur | Objet | Calcul |
|---|---|---|
| Pipeline commercial | Opportunity | IsClosed = false ; regrouper par StageName ou CloseDate ; SELECT SUM(Amount) … GROUP BY StageName ; brut et pondéré (Probability) |
| Taux de transformation | Opportunity | Closes gagnées (IsWon) sur closes (IsClosed), même période |
| Conversion des pistes | Lead | SELECT COUNT() avec IsConverted = true, puis sans ce filtre, même période (CreatedDate) |
| Activité commerciale | Task, Event | Task (ActivityDate, IsClosed) et Event (StartDateTime) par OwnerId |

## Classeurs du contrôle de gestion

Quand un classeur fait foi (tableau « Vos conventions » de la fiche), Claude le lit sur Dropbox ou SharePoint. Si la
lecture signale des classeurs liés, les valeurs datent de la dernière ouverture du fichier : Claude donne cette date et
prévient que les chiffres peuvent être décalés.
