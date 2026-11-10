---
name: indicateurs-financiers
description: Définitions des indicateurs financiers de l'entreprise (chiffre d'affaires, encours client, BFR, délai de paiement, carnet de commandes, achats, pipeline) et façon de les calculer à partir de Sage X3, Salesforce et des classeurs du contrôle de gestion. À utiliser dès qu'une question porte sur un de ces indicateurs ou sur un chiffre de gestion.
---

# Indicateurs financiers

> **En bref.** Cette fiche apprend à Claude ce que veulent dire *vos* indicateurs. Sans elle, il applique une définition
> générale qui peut ne pas être la vôtre. Le contrôle de gestion la tient à jour : il suffit de modifier le tableau
> « Vos conventions » ci-dessous, en français, sans aucune connaissance technique.

## Vos conventions (à compléter par le contrôle de gestion)

Remplacez les exemples en *italique* par vos règles. Une case vide veut dire : Claude demande à l'utilisateur.

| Sujet | Votre règle |
|---|---|
| Sociétés du périmètre | *Société A, Société B (la holding est exclue)* |
| Intragroupe | *Toujours exclu des indicateurs, sauf demande explicite* |
| Chiffre d'affaires | *Comptes 70 hors 709, en HT, à la date comptable* |
| Encours client | *Solde comptable du client, hors intragroupe* |
| BFR | *Stocks + clients − fournisseurs, en fin de mois* |
| Délai de paiement clients (DSO) | *Méthode par épuisement sur les 3 derniers mois* |
| Seuil d'écart significatif | *10 % et 20 000 € à la fois* |
| Source qui fait foi en cas de désaccord | *Le classeur de consolidation mensuel* |

## Les indicateurs

Pour chacun : ce qu'il mesure, où Claude le lit, et l'erreur à ne pas faire. La règle de votre tableau passe toujours
avant la définition ci-dessous.

| Indicateur | Ce qu'il mesure | Où le lire | Erreur à éviter |
|---|---|---|---|
| Chiffre d'affaires | Ventes facturées de la période, en HT, avoirs déduits | Balance comptable (comptes de produits) ; factures de vente pour le détail par client | Le calculer sur les commandes ou les opportunités |
| Prises de commandes | Commandes saisies sur la période | Commandes de vente | Les confondre avec le CA |
| Carnet de commandes | Ce qui reste à livrer ou à facturer sur les commandes ouvertes | Commandes de vente, ligne par ligne | Prendre le total des commandes ouvertes |
| Encours client | Ce que le client doit, à une date | Solde comptable ; à défaut, « Total en-cours » de la fiche client | Prendre le « Total en-cours » de Sage pour une créance : il contient aussi les commandes |
| Retards clients | Factures échues non réglées | Échéances comptables | Conclure sans lettrage : c'est alors une estimation, à dire |
| Achats | Factures fournisseurs de la période, en HT, avoirs déduits | Factures d'achat ; balance (comptes de charges) | Oublier les avoirs |
| Dettes fournisseurs | Ce que l'entreprise doit, à une date | Solde des comptes fournisseurs ; échéances | Se fier aux seules factures |
| BFR | Stocks + créances clients − dettes fournisseurs | Balance comptable ; classeur de consolidation | Mélanger des dates d'arrêté |
| DSO | Encours client exprimé en jours de chiffre d'affaires | Encours + CA TTC des derniers mois | Changer de méthode d'un mois à l'autre |
| Pipeline commercial | Opportunités ouvertes, brutes et pondérées | Salesforce | L'appeler du chiffre d'affaires |
| Taux de transformation des devis | Devis gagnés sur devis émis, même période | Devis Sage X3 ou opportunités Salesforce | Compter les devis encore valides comme perdus |

Le détail technique (objets, champs, filtres) est dans [la fiche de référence Sage X3 et Salesforce](reference.md) :
Claude la lit, vous n'en avez pas besoin.

## Comment Claude doit répondre

1. Dire la définition utilisée en une ligne, et d'où vient la règle (votre tableau ou la définition générale).
2. Donner le chiffre avec son unité, HT ou TTC, la période, le périmètre et la date des données.
3. Citer la source : système, objet ou classeur.
4. Signaler ce qui limite la fiabilité : liste incomplète, pièces non comptabilisées, classeur non recalculé, intragroupe.
5. Si une règle manque dans le tableau, poser la question au lieu de choisir.

Exemple de début de réponse attendu :

> **Encours client X au 31/10 : 412 300 € (solde comptable, hors intragroupe, règle du contrôle de gestion).**
> Source : Sage X3, fiche client, « Détail calcul en-cours ». Le « Total en-cours » Sage est plus élevé (455 800 €) car il
> inclut 43 500 € de commandes non livrées.
