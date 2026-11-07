# kit-pilote-source
Source du portier du kit (règles : `docs/portier.md`). Node 20+, aucune dépendance.

- `src/portier.mjs` : un cycle (cron */5) sur les dépôts `axion-kit` au sujet `kit-projet`.
- `src/porte.mjs` : fusion après approbation de Will (`porte.yml`, environnement `revue-will`).
- `src/lib.mjs` : client API, motifs glob, état de la CI, contrôle « portier ».
- `chemins-sensibles.txt` : motifs sensibles (sans « / » : à tout niveau ; avec : depuis la racine).
- `outils/kit-nouveau.mjs <nom> "<description>" [app_id]` : crée un projet (gh, en local).
- Tests : `node --test` (faux GitHub, aucun réseau).

Configuration attendue dans `kit-pilote` : variables `PORTIER_APP_ID`, `ARRET` (`oui` = arrêt) ; secret `PORTIER_CLE` ;
environnements `pilote` et `revue-will` (approbation de Will). Droits de l'application : checks, pull requests,
contents (fusion), administration (lecture), issues, actions (écriture sur le dépôt du pilote pour lancer `porte.yml`).
