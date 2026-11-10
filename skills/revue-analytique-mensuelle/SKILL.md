---
name: revue-analytique-mensuelle
description: Revue analytique d'un mois clos, société par société - compare le mois à N-1 et au mois précédent, isole les écarts significatifs et propose des explications vérifiées dans Sage X3. À utiliser quand on demande une revue du mois, une analyse des écarts, un commentaire de clôture ou « qu'est-ce qui a bougé ce mois-ci ».
---

# Revue analytique mensuelle

> **En bref.** Vous demandez « Fais la revue analytique d'octobre pour la société A ». Claude compare le mois à l'an
> dernier et au mois précédent, garde seulement les écarts qui dépassent votre seuil et cherche une explication dans
> Sage. Il distingue toujours ce qu'il a **constaté** de ce qu'il **suppose**. Vous relisez et vous validez : il ne
> remplace pas votre jugement.

## Ce que vous pouvez régler (contrôle de gestion)

| Réglage | Valeur actuelle |
|---|---|
| Seuil d'écart | *Les deux à la fois : 10 % et 20 000 €* (sinon : celui de la fiche « Indicateurs financiers ») |
| Comparaisons | *Mois N-1, mois précédent, cumul depuis le début de l'exercice* |
| Postes suivis | *Chiffre d'affaires, achats consommés, charges externes, personnel, clients, fournisseurs, stocks* |
| Nombre maximum d'écarts commentés | *8* |
| Budget | *Pas encore : à ajouter quand le classeur budget sera identifié* |

## Ce que Claude fait, étape par étape

1. **Cadrer.** Société, mois, devise, intragroupe inclus ou non. S'il manque un de ces éléments, il le demande avant
   de commencer.
2. **Vérifier que le mois est exploitable.**
   * La balance est équilibrée (total des débits = total des crédits).
   * Les comptes d'attente sont signalés s'ils ne sont pas soldés.
   * Les factures non comptabilisées sont signalées.

   Si le mois n'est visiblement pas clos, il le dit et s'arrête là.
3. **Rassembler les chiffres.** Balance du mois, du même mois l'an dernier et du mois précédent, par poste, selon les
   définitions de la fiche « Indicateurs financiers ». Les totaux sont calculés par un outil de calcul, jamais de tête.
4. **Isoler les écarts.** Écart en euros et en pourcentage pour chaque poste ; il ne garde que ceux qui dépassent le
   seuil, du plus gros au plus petit.
5. **Chercher l'explication de chaque écart retenu.**
   * Où il regarde : factures, commandes, clients ou fournisseurs principaux du poste.
   * Ce qui compte comme explication : seulement une cause qu'il a lue dans les données.
   * Sinon, il écrit « à expliquer » et propose la question à poser.
6. **Rédiger** au format ci-dessous.

## Format de la réponse

**Revue analytique – Société A – octobre 2026** (données Sage X3 lues le JJ/MM à HH:MM)

**Contrôles préalables :** balance équilibrée ; 2 factures non comptabilisées (3 800 €) ; compte d'attente 471 non soldé.

| Poste | Oct. 2026 | Oct. 2025 | Écart | Écart % | Explication | Statut |
|---|---|---|---|---|---|---|
| Chiffre d'affaires | 1 284 k€ | 1 102 k€ | +182 k€ | +16,5 % | Deux commandes du client X livrées et facturées en octobre (156 k€) | Constaté |
| Achats consommés | 512 k€ | 431 k€ | +81 k€ | +18,8 % | Hausse de prix du fournisseur Y : facture du 14/10 à +12 % | Constaté |
| Charges externes | 96 k€ | 71 k€ | +25 k€ | +35,2 % | Probable facture annuelle de maintenance (à vérifier) | Hypothèse |
| Clients | 2 140 k€ | 1 890 k€ | +250 k€ | +13,2 % | — | À expliquer |

**Questions à poser :** charges externes (confirmer la facture annuelle) ; clients (retards de règlement ou effet du
CA d'octobre ?).

**Limites :** chiffres Sage bruts, avant retraitements du contrôle de gestion ; intragroupe exclu.

Les chiffres de ce format sont fictifs : ils montrent la présentation attendue, rien d'autre.

## Règles

* Jamais d'explication inventée : sans preuve dans les données, c'est « hypothèse » ou « à expliquer ».
* Toujours la source et l'heure de lecture des données.
* Un chiffre destiné à une décision se vérifie dans Sage avant d'être utilisé.
* Si les données nécessaires ne sont pas accessibles (balance non publiée, par exemple), le dire et proposer ce qui
  est faisable : lecture du classeur de consolidation du mois, ou analyse limitée aux achats.
