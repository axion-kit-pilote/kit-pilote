# kit-pilote-source
Source du portier du kit (règles : `docs/portier.md`). Node 20+, aucune dépendance.

- `src/portier.mjs` : un cycle (cron */5) sur les dépôts `axion-kit` au sujet `kit-projet`.
- `src/porte.mjs` : fusion après approbation de Will (`porte.yml`, environnement `revue-will`).
- `src/lib.mjs` : client API, motifs glob, état de la CI, contrôle « portier ».
- `chemins-sensibles.txt` : motifs sensibles (sans « / » : à tout niveau ; avec : depuis la racine).
- `outils/kit-nouveau.mjs <nom> "<description>" [app_id]` : crée un projet (gh, en local).
- `outils/kit-adopter.mjs <proprietaire>/<depot>` : analyse en lecture seule d'un dépôt existant ; écrit un rapport et un `proprietes-<proprietaire>-<depot>.yaml` (proposition à valider, à copier à la racine du projet sous le nom `proprietes.yaml`).
- `outils/kit-maj.mjs` : propage une version du gabarit `axion-kit/kit-modele` (deux SHA, extraction par `git archive`, empreinte comparée à `modele-approuve.txt` s'il existe) vers des copies locales ; à blanc par défaut.
- `catalogue/` : fiches des outils et briques (`node outils/catalogue-index.mjs` génère l'index).
- `transfert-exclus.txt` : chemins que le transfert vers `kit-pilote` (dépôt PUBLIC) doit exclure : `catalogue/`, `outils/kit-adopter.mjs`, `outils/kit-maj.mjs`, `outils/lib/`, `outils/test/`, `docs/`. Le catalogue cite des dépôts privés : il ne part jamais dans `kit-pilote`. Les fiches n'y nomment plus aucun projet interne (test `catalogue.test.mjs`).
- Tests : `node --test` (faux GitHub, aucun réseau).

Configuration attendue dans `kit-pilote` : variables `PORTIER_APP_ID`, `ARRET` (`oui` = arrêt) ; secret `PORTIER_CLE` ;
environnements `pilote` et `revue-will` (approbation de Will). Droits de l'application : checks, pull requests,
contents (fusion), administration (lecture), issues, actions (écriture sur le dépôt du pilote pour lancer `porte.yml`).
