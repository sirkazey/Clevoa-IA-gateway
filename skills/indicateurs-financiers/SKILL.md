---
name: indicateurs-financiers
description: Définitions des indicateurs financiers de l'entreprise (chiffre d'affaires, encours client, BFR, délai de paiement, carnet de commandes, achats, pipeline) et façon de les obtenir depuis Sage X3, Salesforce et les classeurs du contrôle de gestion. À utiliser dès qu'une question porte sur un de ces indicateurs ou sur un chiffre de gestion.
---

# Indicateurs financiers

> **En bref.** Cette fiche apprend à Claude ce que veulent dire *vos* indicateurs, et où les trouver. Le contrôle de
> gestion fixe les règles de la colonne « Votre règle » ; tant qu'une case est vide, Claude ne choisit pas à votre
> place : il pose la question.

## Vos conventions

Seule la colonne « Votre règle » s'applique. La colonne « Exemple » montre une façon de répondre : **Claude ne
l'applique jamais**.

| Sujet | Votre règle | Exemple (jamais appliqué) |
|---|---|---|
| Sociétés du périmètre | | Société A et Société B ; la holding est exclue |
| Intragroupe | | Toujours exclu, sauf demande explicite |
| Devise et conversion des filiales | | Euros ; filiales converties au taux moyen du mois |
| Exercice | | Du 1er janvier au 31 décembre |
| Chiffre d'affaires | | Comptes 70, nets des 709 (rabais, remises, ristournes), en HT, date comptable |
| Encours client | | Solde comptable du client, hors intragroupe, avant dépréciation |
| BFR | | BFR d'exploitation simplifié : stocks + clients − fournisseurs, fin de mois |
| Délai de paiement clients (DSO) | | Méthode par épuisement sur les 3 derniers mois |
| Seuil d'écart significatif | | 10 % ou 50 000 € (l'un ou l'autre suffit) |
| Source qui fait foi en cas de désaccord | | Le classeur de consolidation mensuel |

## Ce qui est disponible aujourd'hui

Claude n'a accès qu'à ce que Sage X3 publie. Sans la donnée, il le dit et ne donne **aucun chiffre approché**.

| Donnée | Disponible ? |
|---|---|
| Factures fournisseurs, commandes de vente et d'achat, fiches clients et fournisseurs | Oui |
| Exposition totale d'un client (« Total en-cours » de la fiche) | Oui, client par client |
| Classeurs du contrôle de gestion (Dropbox, SharePoint) | Oui |
| Comptabilité (écritures, balance), factures de vente, échéances | Non : demandées à l'intégrateur |

## Les indicateurs

La règle de votre tableau passe toujours avant la définition ci-dessous.

| Indicateur | Ce qu'il mesure | Où le lire | Erreur à éviter |
|---|---|---|---|
| Chiffre d'affaires | Ventes de la période, en HT, avoirs et remises déduits | Classeur qui fait foi ; sinon comptabilité ou factures de vente, quand elles seront publiées | Le calculer sur les commandes ou les opportunités |
| Prises de commandes | Commandes saisies sur la période, annulations déduites | Commandes de vente | Les confondre avec le CA |
| Carnet de commandes | Ce qui reste à livrer sur les commandes ouvertes, en HT | Commandes de vente, ligne par ligne | Prendre le total des commandes ouvertes ; y ajouter le livré non facturé, suivi à part |
| Encours client | Ce que le client doit en comptabilité, à une date | Comptabilité, quand elle sera publiée, ou classeur | Appeler « encours » le Total en-cours de Sage : c'est une **exposition totale**, commandes comprises, à présenter sous ce nom |
| Retards clients | Factures échues non réglées | Échéances, quand elles seront publiées | Déduire un retard d'une date d'échéance seule |
| Achats facturés | Factures fournisseurs de la période, en HT, avoirs déduits | Factures d'achat | Les appeler « achats consommés » (il manque la variation de stock) |
| Dettes fournisseurs | Ce que l'entreprise doit, à une date | Comptabilité ; à défaut, échéancier théorique des factures d'achat, à nommer ainsi | Présenter l'échéancier théorique comme des dettes réelles |
| BFR | Selon votre règle ; par défaut « BFR d'exploitation simplifié » | Classeur qui fait foi ; comptabilité quand elle sera publiée | L'appeler BFR sans dire qu'il est simplifié |
| DSO | Encours client exprimé en jours de chiffre d'affaires TTC | Classeur ; ou encours et CA TTC lus tels quels | Reconstituer un TTC en appliquant un taux de TVA |
| Pipeline commercial | Opportunités ouvertes, brutes et pondérées | Salesforce | L'appeler du chiffre d'affaires |
| Taux de transformation des devis | Devis émis sur une période et transformés en commande, rapportés aux devis de cette période désormais clos | Devis Sage X3 ou opportunités Salesforce | Compter comme perdus les devis encore valides : les exclure et dire combien |

Le détail technique (objets, champs, outils) est dans [la fiche de référence](reference.md).

## Comment Claude doit répondre

1. Dire la définition utilisée en une ligne, et d'où vient la règle : votre tableau, ou la définition par défaut.
2. Donner le chiffre avec son unité, HT ou TTC, la période, le périmètre, la source et l'heure de lecture.
3. Additionner seulement une liste complète, avec l'exécution de code si elle est disponible ; sinon montrer
   l'addition. Liste incomplète : pas de total, le dire.
4. Signaler ce qui limite la fiabilité : pièces non comptabilisées, classeur non recalculé, intragroupe.
5. Si une règle manque ou si la donnée n'est pas disponible, le dire et poser la question, sans estimer.

Exemple de réponse attendue (chiffres fictifs) :

> **Encours comptable du client X au 31/10 : non disponible**, la comptabilité n'est pas encore publiée. Son
> **exposition totale** dans Sage (« Total en-cours ») est de 455 800 € TTC. Elle comprend aussi ses commandes, ses
> livraisons non facturées et ses factures non comptabilisées ; le détail n'est pas lisible.
> Source : Sage X3, fiche client X, lue le 31/10 à 9 h 12.
