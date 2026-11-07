// Surveillance quotidienne (L6) des dépôts PUBLICS d'axion-kit et d'axion-kit-pilote :
//  1. gitleaks (binaire à somme vérifiée, installé par le workflow) sur l'historique d'un clone NU, avec
//     --ignore-gitleaks-allow ; les exemptions « allow » de l'historique sont comptées (G2) ;
//  2. noms de clients (secret NOMS_CLIENTS) dans toutes les références et tout l'historique.
// Les journaux sont publics : seuls des codes fixes et des noms de dépôts sont écrits.
// Ni une valeur trouvée, ni un nom de client, ni un chemin de fichier ne sont affichés ou écrits.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { ORG, ORG_PILOTE, PILOTE_PAR_DEFAUT, creerApi, alerter } from './client6.mjs';

const exec = promisify(execFile);
export const CONFIG_GITLEAKS = join(dirname(fileURLToPath(import.meta.url)), '..', 'config', 'gitleaks.toml');
const NOM_DEPOT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
export const LONGUEUR_MIN_NOM = 3;

// Liste du secret : un nom par ligne ou séparés par des virgules / points-virgules.
export function parserNoms(texte) {
  const noms = String(texte ?? '').split(/[\r\n,;]+/).map((x) => x.trim()).filter((x) => x.length >= LONGUEUR_MIN_NOM);
  return [...new Set(noms)];
}

// Motif ERE insensible aux accents : chaque lettre devient une alternance de ses formes accentuées (précomposées),
// écrite en toutes lettres (jamais de crochets : sûr quel que soit le jeu de caractères). Casse : option -i en plus.
const VARIANTES = (() => {
  const m = new Map();
  for (let cp = 0xc0; cp <= 0x24f; cp++) {
    const c = String.fromCodePoint(cp), nfd = c.normalize('NFD');
    if (nfd.length > 1 && /^[A-Za-z]$/.test(nfd[0])) {
      const b = nfd[0].toLowerCase();
      m.set(b, new Set([...(m.get(b) ?? []), c.toLowerCase(), c.toUpperCase()]));
    }
  }
  return m;
})();
export function motifNom(nom) {
  const sans = String(nom).normalize('NFD').replace(/[\u0300-\u036f]/g, '').normalize('NFC');
  return [...sans].map((ch) => {
    const v = VARIANTES.get(ch.toLowerCase());
    if (v) return `(${[ch.toLowerCase(), ch.toUpperCase(), ...v].join('|')})`;
    return ch.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }).join('');
}

// ---- implémentations réelles (remplacées dans les tests) ----
export function outilsReels(env = process.env) {
  const bin = env.GITLEAKS_BIN || 'gitleaks';
  return {
    // Clone NU : aucun fichier de travail, donc aucun .gitleaksignore ni .gitleaks.toml du dépôt scanné sur disque.
    async cloner(org, nom, dest) {
      const base = env.SURVEILLER_URL_BASE || 'https://github.com';
      await exec('git', ['clone', '--bare', '--quiet', `${base}/${org}/${nom}.git`, dest], { timeout: 300000 });
    },
    // -> nombre de commits de l'historique qui ajoutent ou retirent « gitleaks:allow » (exemption possible d'une fuite)
    async compterAllow(dir) {
      try {
        const r = await exec('git', ['-C', dir, 'log', '--all', '-S', 'gitleaks:allow', '--format=%H'], { maxBuffer: 1 << 26, timeout: 900000 });
        return r.stdout.split('\n').filter(Boolean).length;
      } catch { throw new Error('comptage des exemptions échoué'); }
    },
    // -> nombre de fuites ; exception si l'outil échoue
    async gitleaks(dir) {
      const rep = await mkdtemp(join(tmpdir(), 'gl-'));
      const rapport = join(rep, 'r.json');
      const vide = join(rep, 'ignore-vide');   // dossier vide, hors du clone : aucun .gitleaksignore du dépôt scanné
      await mkdir(vide);
      try {
        try {
          // --ignore-gitleaks-allow : les commentaires « gitleaks:allow » du dépôt scanné sont sans effet.
          await exec(bin, ['git', '--ignore-gitleaks-allow', '--config', CONFIG_GITLEAKS, '--gitleaks-ignore-path', vide,
            '--redact', '--no-banner', '--log-level', 'error', '--exit-code', '2', '--report-format', 'json', '--report-path', rapport, dir], { cwd: vide, timeout: 600000, maxBuffer: 1 << 20 });
          return 0;
        } catch (e) {
          if (e.code !== 2) throw new Error('gitleaks a échoué');
          try { return Math.max(1, JSON.parse(await readFile(rapport, 'utf8')).length); } catch { return 1; }
        }
      } finally { await rm(rep, { recursive: true, force: true }); }
    },
    // -> { fichiers, commits } : nombres seulement
    async chercherNoms(dir, noms) {
      const rep = await mkdtemp(join(tmpdir(), 'nc-'));
      const liste = join(rep, 'n');
      try {
        await writeFile(liste, noms.map(motifNom).join('\n') + '\n', { mode: 0o600 });
        const chemins = new Set();   // chemins distincts (nombre seulement : jamais écrits)
        const ref = await exec('git', ['-C', dir, 'for-each-ref', '--format=%(refname)'], { maxBuffer: 1 << 24 });
        const refs = ['HEAD', ...ref.stdout.split('\n').filter(Boolean)];
        // arbres de toutes les références (branche etat comprise), par lots
        for (let i = 0; i < refs.length; i += 50) {
          try {
            const r = await exec('git', ['-C', dir, 'grep', '-I', '-i', '-E', '-l', '-f', liste, ...refs.slice(i, i + 50), '--'], { maxBuffer: 1 << 24 });
            for (const l of r.stdout.split('\n')) if (l) chemins.add(l.slice(l.indexOf(':') + 1));
          } catch (e) { if (e.code !== 1) throw new Error('recherche des noms échouée'); }
        }
        // historique complet : messages (-F) et contenu ajouté ou retiré (pickaxe, sans casse)
        const commits_trouves = new Set();
        const log = async (args) => {
          try {
            const r = await exec('git', ['-C', dir, 'log', '--all', '-i', '--format=%H', ...args], { maxBuffer: 1 << 26, timeout: 900000 });
            for (const l of r.stdout.split('\n')) if (l) commits_trouves.add(l);
          } catch { throw new Error('recherche des noms échouée'); }
        };
        await log(['-E', ...noms.map((n) => `--grep=${motifNom(n)}`)]);
        for (const n of noms) await log(['--pickaxe-regex', `-S${motifNom(n)}`]);
        const fichiers = chemins.size;
        const commits = commits_trouves.size;
        return { fichiers, commits };
      } finally { await rm(rep, { recursive: true, force: true }); }
    },
  };
}

export async function surveiller({ env = process.env, fetchImpl = fetch, outils = outilsReels(env), log = console.log } = {}) {
  const pilote = env.GITHUB_REPOSITORY || PILOTE_PAR_DEFAUT;
  const api = creerApi({ token: env.GH_TOKEN, fetchImpl });
  const apiPilote = creerApi({ token: env.PILOTE_TOKEN, fetchImpl });
  const noms = parserNoms(env.NOMS_CLIENTS);
  const cibles = [];
  for (const d of await api.liste(`/orgs/${ORG}/repos?type=public`)) if (!d.private) cibles.push([ORG, d.name]);
  for (const d of await apiPilote.liste(`/orgs/${ORG_PILOTE}/repos?type=public`)) if (!d.private) cibles.push([ORG_PILOTE, d.name]);
  if (noms.length === 0) {
    log('NOMS_CLIENTS vide ou absent : recherche des noms impossible');
    await alerter(apiPilote, pilote, 'NOMS_CLIENTS absent', ['Le secret NOMS_CLIENTS (environnement sas) est vide ou absent : la recherche des noms de clients ne se fait pas.']);
  }
  const bilan = { depots: 0, fuites: 0, allow: 0, noms: 0, impossibles: 0 };
  const racine = await mkdtemp(join(tmpdir(), 'surv-'));
  try {
    for (const [org, nom] of cibles) {
      if (!NOM_DEPOT.test(nom)) { log('dépôt au nom inattendu ignoré'); bilan.impossibles++; continue; }
      const dest = join(racine, `${org}__${nom}`);
      bilan.depots++;
      try {
        await outils.cloner(org, nom, dest);
        const fuites = await outils.gitleaks(dest);
        if (fuites > 0) {
          bilan.fuites++;
          log('FUITE possible (code G1)');   // ni dépôt ni fichier : le journal est public
        }
        // kit-pilote contient lui-même ce texte (code, tests, docs) : ignoré pour ce seul dépôt
        const propre = `${org}/${nom}` === pilote;
        const allow = propre || !outils.compterAllow ? 0 : await outils.compterAllow(dest);
        if (allow > 0) {
          bilan.allow++;
          log('FUITE possible (code G2)');   // exemption gitleaks dans l'historique : ni dépôt ni valeur
        }
        if (noms.length) {
          const { fichiers, commits } = await outils.chercherNoms(dest, noms);
          if (fichiers + commits > 0) {
            bilan.noms++;
            log(`${org}/${nom} : nom de client trouvé (code N1)`);
            await alerter(apiPilote, pilote, `nom de client trouvé dans ${org}/${nom}`, [
              `Un nom de la liste secrète NOMS_CLIENTS apparaît dans ${fichiers} fichier(s) et ${commits} message(s) de commit de ce dépôt public. Le nom n'est pas recopié ici.`,
              'À faire : rendre le dépôt privé si besoin, retirer le nom, puis réécrire l\'historique.',
            ]);
          }
        }
      } catch (e) {
        bilan.impossibles++;
        log(`${org}/${nom} : contrôle impossible (code E1)`);
        await alerter(apiPilote, pilote, `surveillance impossible sur ${org}/${nom}`, ['Le contrôle quotidien n\'a pas pu aller au bout (code E1). Voir le journal du workflow surveiller.']);
      } finally { await rm(dest, { recursive: true, force: true }); }
    }
  } finally { await rm(racine, { recursive: true, force: true }); }
  if (bilan.fuites > 0) {
    // Une alerte publique n'indique ni le dépôt ni le fichier : le titre porte le nombre pour qu'une nouvelle fuite re-alerte.
    await alerter(apiPilote, pilote, `fuite possible dans ${bilan.fuites} dépôt(s)`, [
      'gitleaks signale une fuite possible dans un dépôt public ; vérifier en local avec kit verifier. Ni le dépôt, ni le fichier, ni la valeur ne sont indiqués ici.',
      'À faire dans l\'ordre : 1) révoquer le secret ; 2) rendre le dépôt privé ; 3) réécrire l\'historique ensuite (les copies gardent l\'objet).',
    ]);
  }
  if (bilan.allow > 0) {
    await alerter(apiPilote, pilote, `exemptions gitleaks dans l'historique de ${bilan.allow} dépôt(s)`, [
      'Un marqueur d\'exemption gitleaks (commentaire « allow ») figure dans l\'historique d\'un dépôt public : il peut masquer une fuite. Le scan l\'ignore déjà (aucune fuite masquée), mais il faut vérifier en local avec kit verifier. Ni le dépôt, ni le fichier ne sont indiqués ici (code G2).',
    ]);
  }
  log(`surveillance : ${bilan.depots} dépôt(s), ${bilan.fuites} fuite(s), ${bilan.allow} exemption(s), ${bilan.noms} nom(s), ${bilan.impossibles} impossible(s)`);
  return bilan;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  surveiller().catch(() => { console.error('surveiller : échec (code E0)'); process.exitCode = 1; });
}
