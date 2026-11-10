# Compétences métier (skills) pour Claude

Public : contrôleurs de gestion, DAF et l'Owner Claude de l'entreprise. Objet : ce que sont ces fiches, comment les
lire, les modifier et les installer.

Une compétence (« skill ») est une **fiche écrite en français** que Claude lit avant de répondre. Elle lui apprend une
façon de travailler : la définition de vos indicateurs, ou les étapes de votre revue mensuelle. La passerelle Clevoa
donne l'accès aux données ; ces fiches disent quoi en faire.

## Les fiches disponibles (ébauches)

| Fiche | À quoi elle sert | Ce que le contrôle de gestion complète |
|---|---|---|
| [Indicateurs financiers](indicateurs-financiers/SKILL.md) | Définir CA, encours, BFR, DSO, carnet… et dire où les lire | Le tableau « Vos conventions » |
| [Revue analytique mensuelle](revue-analytique-mensuelle/SKILL.md) | Comparer le mois à N-1, isoler et expliquer les écarts | Le tableau des réglages (seuils, postes) |

## Lire et modifier une fiche

1. Ouvrez le fichier SKILL.md de la fiche. Ignorez les quatre premières lignes, entre tirets : c'est l'étiquette qui
   dit à Claude quand utiliser la fiche.
2. Modifiez seulement les tableaux de réglages, en remplaçant les exemples en *italique*. Écrivez comme à un nouveau
   collègue : phrases courtes, chiffres précis.
3. Testez : posez une question à Claude et vérifiez qu'il cite votre règle.

Vous n'avez rien à modifier dans les fichiers `reference.md` : ils traduisent les indicateurs en champs techniques.

## Installer une fiche dans Claude

Chaque fiche est un dossier. On le compresse en `.zip`, puis on l'ajoute dans Claude, dans les paramètres
(rubrique des compétences). L'Owner peut la mettre à disposition de toute l'organisation. L'emplacement exact du menu
évolue : suivez l'aide de Claude.

## Ce qui ne va jamais dans ce dossier

Vos vraies conventions, vos montants, vos noms de clients. Ce dossier est un modèle commun à tous les clients : la
version remplie de chaque entreprise reste chez elle, dans son organisation Claude.
