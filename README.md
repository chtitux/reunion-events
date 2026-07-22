# Événements de La Réunion

Agenda ouvert et collaboratif des événements de l'île de La Réunion. Toutes les données tiennent dans un seul fichier CSV, que chacun peut compléter par pull request.

**Agenda en ligne :** https://axelearning.github.io/reunion-events/

## Contribuer

Les données vivent dans [`reunion_events.csv`](reunion_events.csv). Une ligne = un événement.

Depuis le navigateur, sans aucun outil :

1. Ouvrez [`reunion_events.csv`](reunion_events.csv) sur GitHub.
2. Cliquez sur le crayon (« Edit this file »).
3. Ajoutez votre ligne en respectant les colonnes ci-dessous.
4. « Propose changes » puis **Create pull request**.

Merci d'éviter les doublons et de garder les lignes triées par `date_debut`.

### Format des colonnes

| Colonne      | Obligatoire | Exemple              | Notes                                                        |
| ------------ | ----------- | -------------------- | ------------------------------------------------------------ |
| `date_debut` | oui         | `2026-10-15`         | Format `AAAA-MM-JJ`                                          |
| `date_fin`   | non         | `2026-10-18`         | Vide si l'événement dure un seul jour                        |
| `nom`        | oui         | `Grand Raid`         | Guillemets si le nom contient une virgule : `"Dipavali, fête de la lumière"` |
| `communes`   | oui         | `Cilaos\|Entre-Deux` | Communes concernées, séparées par `\|` — ou `ALL` si toute l'île est concernée |
| `categorie`  | oui         | `Sport`              | `Sport`, `Culture`, `Religieux`, `Jour férié`                |
| `lien`       | non         | `https://…`          | Site officiel de l'événement (http/https uniquement)         |

### Validation automatique

Chaque pull request déclenche [`validate-csv.yml`](.github/workflows/validate-csv.yml), qui exécute [`scripts/validate_csv.py`](scripts/validate_csv.py) : format des dates, présence du `nom`, appartenance des `communes` aux 24 communes de La Réunion (ou `ALL`), `categorie` connue, validité du `lien` et tri croissant par `date_debut`. Les lignes fautives sont annotées directement dans la pull request.

En local :

```bash
python3 scripts/validate_csv.py
```

## Le site

[`index.html`](index.html) : une seule page statique, sans dépendance ni étape de build. Elle lit le CSV et l'affiche sous forme de tableau triable avec recherche. Hébergée par GitHub Pages ; chaque poussée sur `main` redéploie automatiquement le site via GitHub Actions ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)).

> ⚙️ Le déploiement passe par GitHub Actions : dans **Settings → Pages**, choisissez **Source : GitHub Actions**.

En local :

```bash
python3 -m http.server
# puis ouvrir http://localhost:8000
```

## Fichier ICS (calendrier)

[`generate_ics.py`](generate_ics.py) lit le CSV et produit un fichier `events.ics` (fuseau **`Indian/Reunion`**, UTC+4) que l'on peut importer dans Google Agenda, Apple Calendrier, Outlook… La sérialisation iCalendar s'appuie sur la bibliothèque Python [`icalendar`](https://pypi.org/project/icalendar/) (échappement, pliage des lignes et structure conformes RFC 5545). Le workflow de déploiement le régénère à chaque mise à jour et le publie à côté du site (lien « s'abonner au calendrier » en pied de page).

Pour le générer en local :

```bash
pip install -r requirements.txt
python3 generate_ics.py            # → events.ics
# ou : python3 generate_ics.py <source.csv> <sortie.ics>
```

## Licence

Données et code placés dans le domaine public sous [CC0 1.0](LICENSE) : réutilisation, modification et redistribution libres, y compris à des fins commerciales. La mention de la source est appréciée mais pas obligatoire.
