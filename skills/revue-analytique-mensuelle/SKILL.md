---
name: revue-analytique-mensuelle
description: Revue analytique d'un mois clos, société par société : compare le mois aux périodes choisies par le contrôle de gestion, isole les écarts significatifs et propose des explications vérifiées dans les données. À utiliser quand on demande une revue du mois, une analyse des écarts, un commentaire de clôture ou « qu'est-ce qui a bougé ce mois-ci ».
---

# Revue analytique mensuelle

> **En bref.** Vous demandez « Fais la revue analytique d'octobre pour la société A ». Claude compare le mois aux
> périodes que vous avez réglées, garde les écarts qui dépassent votre seuil et cherche leur explication dans les
> données. Chaque explication est classée : **constatée**, **partielle**, **hypothèse** ou **à expliquer**. Vous relisez
> et vous validez : il ne remplace pas votre jugement.

## Ce que vous réglez

Seule la colonne « Votre règle » s'applique ; une case vide, Claude la demande. Le seuil d'écart se règle dans la fiche
« Indicateurs financiers », nulle part ailleurs.

| Réglage | Votre règle | Exemple (jamais appliqué) |
|---|---|---|
| Comparaisons | | N-1 et mois précédent ; cumul de l'exercice en fin de trimestre |
| Nombre d'écarts commentés | | Les 8 plus gros ; les suivants listés sans commentaire |

| Poste suivi | Votre règle (comptes, mouvement ou solde) | Exemple (jamais appliqué) |
|---|---|---|
| Chiffre d'affaires | | 70 nets des 709, mouvement du mois |
| Achats consommés | | 60, y compris la variation de stocks 603, mouvement du mois |
| Charges externes | | 61 et 62 hors intérim, mouvement du mois |
| Personnel | | 64 + intérim (621), mouvement du mois |
| Clients | | 411, 413, 416, solde de fin de mois |
| Fournisseurs | | 401, 403, solde de fin de mois |
| Stocks | | Classe 3, solde de fin de mois |

## Ce que Claude fait, étape par étape

0. **Vérifier l'accès.** La revue par poste demande la comptabilité de Sage X3. Si elle n'est pas publiée, Claude le
   dit tout de suite et propose ce qui est faisable :
   * la revue du classeur de consolidation du mois ;
   * une revue limitée aux achats facturés.

   Il n'invente aucun contrôle ni aucun chiffre comptable.
1. **Cadrer.** Société, mois, devise, intragroupe inclus ou non (selon la règle Intragroupe de la fiche Indicateurs) :
   s'il en manque un, il le demande.
2. **Contrôles de clôture.** Il signale ce qu'il peut lire :
   * pièces provisoires ou non comptabilisées ;
   * comptes d'attente non soldés ;
   * factures non parvenues et factures à établir, si elles sont identifiables.

   Ce qu'il ne peut pas vérifier, il l'écrit « non vérifiable ».
3. **Rassembler les chiffres.** Pour chaque poste, selon votre tableau :
   * charges et produits : mouvements du mois ;
   * clients, fournisseurs et stocks : soldes de fin de mois.

   Les totaux se calculent sur des listes complètes, avec l'exécution de code si elle est disponible. Sinon, il montre
   l'addition.
4. **Isoler les écarts.** Écart en euros et en pourcentage, contre chaque comparaison réglée. Il garde ceux qui
   dépassent le seuil, flux puis soldes, chacun du plus gros au plus petit écart en euros, et liste avec leur montant
   ceux qu'il écarte.
5. **Expliquer.** Il cherche les causes dans les factures, les commandes, les principaux clients et fournisseurs du
   poste. Il chiffre la part de l'écart commenté que chaque cause explique ; au-delà de 100 %, d'autres effets jouent en
   sens inverse et sont chiffrés aussi :

   | Statut | Quand |
   |---|---|
   | Constaté | La cause est lue dans les données et couvre au moins 80 % de l'écart |
   | Partiel | La cause est lue mais couvre moins de 80 % : le reste est chiffré |
   | Hypothèse | Cause plausible, non lue dans les données |
   | À expliquer | Aucune cause trouvée : il propose la question à poser |

6. **Rédiger** au format ci-dessous.

## Format de la réponse (chiffres fictifs, comptabilité publiée)

Sans comptabilité publiée, la réponse s'arrête à l'étape 0 : « Revue par poste impossible : la comptabilité n'est pas
publiée dans Sage X3. Je peux faire la revue du classeur de consolidation d'octobre, ou une revue des achats
facturés. »

**Revue analytique – Société A – octobre 2026** (Sage X3 lu le 05/11 à 9 h 12  ; k€ : flux en HT, soldes de tiers en TTC)

**Contrôles de clôture :** 2 factures fournisseurs non comptabilisées (3,8 k€ HT) ; compte d'attente 471 non soldé ;
factures non parvenues : non vérifiable.

| Poste | Oct. 2026 | Oct. 2025 | Écart N-1 | Sept. 2026 | Écart M-1 | Explication | Statut |
|---|---|---|---|---|---|---|---|
| Chiffre d'affaires | 1 284 | 1 102 | +182 (+16,5 %) | 1 190 | +94 (+7,9 %) | Deux commandes du client X facturées en octobre : 140 k€ ; 42 k€ restent à expliquer | Partiel |
| Achats consommés | 512 | 431 | +81 (+18,8 %) | 498 | +14 (+2,8 %) | Hausse de prix du fournisseur Y (+12 %) : 47 k€ ; 34 k€ restent à expliquer (effet volume non analysé) | Partiel |
| Charges externes | 96 | 71 | +25 (+35,2 %) | 74 | +22 (+29,7 %) | Probable facture annuelle de maintenance (non lue) ; 25 k€ restent à expliquer | Hypothèse |
| Clients (TTC) | 2 140 | 1 890 | +250 (+13,2 %) | 2 020 | +120 (+5,9 %) | — | À expliquer |

Explications et statuts portent sur l'écart N-1 ; les écarts M-1 se commentent de la même façon (non montré ici).

**Écarts sous le seuil, non commentés (N-1) :** personnel +6 k€ (+2,1 %) ; fournisseurs (TTC) −21 k€ (−3,4 %) ;
stocks +18 k€ (+2,5 %).

**Questions à poser :** charges externes (confirmer la facture annuelle) ; clients (retards de règlement ou effet du
CA d'octobre ?).

**Limites :** chiffres Sage bruts, avant retraitements du contrôle de gestion ; intragroupe exclu.

## Règles

* Jamais d'explication inventée : sans preuve dans les données, c'est « hypothèse » ou « à expliquer ».
* Toujours la part chiffrée de l'écart expliquée, et le reste.
* Toujours la source, l'heure de lecture et HT ou TTC.
* Si la fiche « Indicateurs financiers » n'est pas disponible, demander les définitions avant de commencer.
* Un chiffre destiné à une décision se vérifie dans Sage avant d'être utilisé.
