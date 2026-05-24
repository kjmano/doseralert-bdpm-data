# doseralert-bdpm-data

📦 **Snapshots mensuels automatisés de la Base de Données Publique des Médicaments (BDPM)** — servis via CDN jsDelivr et consommés par l'app mobile Doser Alert.

## Données

| Fichier | Taille | Description |
|---|---|---|
| [`medications.min.json`](./medications.min.json) | ~5.7 MB | Catalogue slim : recherche & affichage liste (champs essentiels) |
| [`medications.full.json`](./medications.full.json) | ~13 MB | Catalogue complet : présentations CIP13, prix, remboursement (fiche détaillée) |
| [`version.json`](./version.json) | 212 B | Métadonnées : date, count, hash (sync incrémentale) |

## Source

[Base de Données Publique des Médicaments](https://base-donnees-publique.medicaments.gouv.fr/) — publiée par l'ANSM, la HAS et l'Assurance Maladie.

📜 **Licence** : [Licence Ouverte Etalab v2.0](https://www.etalab.gouv.fr/licence-ouverte-open-licence) — réutilisation libre, y compris commerciale, avec mention de la source.

## URLs CDN

Consommables depuis n'importe quelle app, sans clé d'API, gratuit, bande passante illimitée (jsDelivr) :

```
https://cdn.jsdelivr.net/gh/kjmano/doseralert-bdpm-data@main/version.json
https://cdn.jsdelivr.net/gh/kjmano/doseralert-bdpm-data@main/medications.min.json
https://cdn.jsdelivr.net/gh/kjmano/doseralert-bdpm-data@main/medications.full.json
```

Pour pinner une version précise :
```
https://cdn.jsdelivr.net/gh/kjmano/doseralert-bdpm-data@v2026-05-24/medications.min.json
```

## Automatisation

Le workflow [`bdpm-monthly.yml`](./.github/workflows/bdpm-monthly.yml) :

- s'exécute le **1er de chaque mois à 02:00 UTC**
- ré-extrait la BDPM, compare le hash avec la version précédente
- ne publie que si réellement modifié
- crée un tag `v<YYYY-MM-DD>`
- purge le cache jsDelivr automatiquement

Déclenchement manuel via l'onglet **Actions** → **BDPM monthly snapshot** → **Run workflow**.

## Build local

Aucune dépendance npm — utilise `fetch` + `TextDecoder` natifs (Node ≥ 20).

```bash
node scripts/build-bdpm/build.mjs
# → out/medications.min.json
# → out/medications.full.json
# → out/version.json
```

## Schéma `medications.min.json`

```json
{
  "version": "2026-05-24",
  "generatedAt": "2026-05-24T02:00:00.000Z",
  "source": "BDPM (ANSM/HAS/Ameli) — Licence Ouverte Etalab",
  "count": 15049,
  "medications": [
    {
      "cis": "60002283",
      "name": "DOLIPRANE 1000 mg, comprimé",
      "shortName": "DOLIPRANE",
      "form": "comprimé",
      "administration": "orale",
      "holder": "SANOFI AVENTIS FRANCE",
      "substancesLabel": "PARACÉTAMOL 1000 mg",
      "marketingStatus": "Commercialisée",
      "prescriptionRequired": false,
      "generic": false
    }
  ]
}
```
