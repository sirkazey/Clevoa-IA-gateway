# Compétences métier (skills) pour Claude

Public : contrôleurs de gestion, DAF et administrateur de l'organisation Claude de l'entreprise. Objet : ce que sont ces
fiches et comment elles sont remplies, installées et testées.

Une compétence (« skill ») est une **fiche écrite en français** que Claude lit avant de répondre. Elle lui apprend une
façon de travailler : la définition de vos indicateurs, ou les étapes de votre revue mensuelle. La passerelle Clevoa
donne l'accès aux données ; ces fiches disent quoi en faire.

## Les fiches disponibles (ébauches)

| Fiche | À quoi elle sert | Ce que le contrôle de gestion décide |
|---|---|---|
| [Indicateurs financiers](indicateurs-financiers/SKILL.md) | Définir CA, encours, BFR, DSO, carnet… et dire où les lire | Ses règles : périmètre, intragroupe, définitions, seuil |
| [Revue analytique mensuelle](revue-analytique-mensuelle/SKILL.md) | Comparer le mois à N-1, isoler et expliquer les écarts | Les comparaisons et les comptes de chaque poste |

## Qui fait quoi

1. **Le contrôle de gestion décide des règles**, sans toucher à aucun fichier : il remplit le questionnaire qu'on lui
   remet (une ligne en français par règle).
2. **L'administrateur Claude de l'entreprise** reporte ces règles dans la colonne « Votre règle » de la copie de
   l'entreprise, puis la charge dans Claude pour toute l'organisation.
3. **Le contrôle de gestion vérifie** : il pose une question à Claude et regarde si la réponse cite sa règle. Si non,
   il le signale à l'administrateur.

Deux principes rendent les fiches sûres :

* **Une case vide ne devine rien.** Claude pose la question.
* **La colonne « Exemple » n'est jamais appliquée.** Elle montre seulement une façon de répondre.

## Installer une fiche (administrateur)

Chaque fiche est un dossier. On le compresse en `.zip` et on l'ajoute dans les paramètres de Claude, rubrique des
compétences, pour toute l'organisation. Après chaque modification, on recharge le `.zip`, puis on ouvre une nouvelle
conversation pour tester. Le fichier `reference.md` traduit les indicateurs en champs techniques : il ne change que si
l'instance Sage X3 diffère.

## Ce qui ne va jamais dans ce dossier

Vos vraies règles, vos montants, vos noms de clients. Ce dossier est un modèle commun à tous les clients : la copie
remplie de chaque entreprise reste chez elle, dans son organisation Claude.
