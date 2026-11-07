import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { surveiller, parserNoms, outilsReels, motifNom, CONFIG_GITLEAKS } from '../src/surveiller.mjs';
import { creerFake, depot, envSonde } from './fake6.mjs';

const SECRET_NOM = 'Zorglub-Industries';
function monde(opts = {}) {
  const f = creerFake({ depots: [depot('pub1'), depot('prive1', { private: true }), depot('pub2')] });
  f.etat.depotsPilote = ['kit-pilote'];
  const journal = [];
  const outils = {
    clones: [],
    async cloner(org, nom) { this.clones.push(`${org}/${nom}`); },
    async gitleaks(dir) { if (opts.erreur && dir.endsWith('pub2')) throw new Error(`secret-${SECRET_NOM}`); return dir.endsWith('pub1') ? (opts.fuites ?? 0) : 0; },
    async compterAllow(dir) { return dir.endsWith('pub2') ? (opts.allow ?? 0) : 0; },
    async chercherNoms(dir) { return dir.endsWith('pub2') ? (opts.noms ?? { fichiers: 0, commits: 0 }) : { fichiers: 0, commits: 0 }; },
  };
  const run = (env = {}) => surveiller({ env: envSonde({ NOMS_CLIENTS: SECRET_NOM, ...env }), fetchImpl: f.fetch, outils, log: (m) => journal.push(m) });
  return { f, outils, journal, run };
}
const alertes = (f) => f.etat.issues.filter((i) => i.title.startsWith('ALERTE'));

test('parserNoms : lignes ou virgules, doublons et noms trop courts écartés', () => {
  assert.deepEqual(parserNoms('Alpha\r\nBeta, Alpha;ab\n\n'), ['Alpha', 'Beta']);
  assert.deepEqual(parserNoms(undefined), []);
});

test('seuls les dépôts publics des deux organisations sont parcourus', async () => {
  const m = monde();
  const b = await m.run();
  assert.deepEqual(m.outils.clones.sort(), ['axion-kit-pilote/kit-pilote', 'axion-kit/pub1', 'axion-kit/pub2']);
  assert.equal(b.depots, 3);
  assert.equal(alertes(m.f).length, 0);
});

test('fuite gitleaks -> alerte sans valeur, une seule fois', async () => {
  const m = monde({ fuites: 2 });
  await m.run(); await m.run();
  assert.equal(alertes(m.f).length, 1);
  assert.match(alertes(m.f)[0].title, /fuite possible dans 1 dépôt/);
  assert.match(alertes(m.f)[0].body, /révoquer/);
  assert.match(alertes(m.f)[0].body, /kit verifier/);
});

test('S4 : ni le dépôt ni le fichier d\'une fuite possible dans l\'issue publique ni dans le journal', async () => {
  const m = monde({ fuites: 2 });
  await m.run();
  const tout = JSON.stringify(m.f.etat.issues) + m.journal.join('\n');
  assert.ok(!/pub1/.test(tout), tout);
  assert.ok(m.journal.some((l) => /G1/.test(l)));
});

test('S4 : une seconde fuite (autre nombre) crée une nouvelle alerte', async () => {
  const m = monde({ fuites: 1 });
  await m.run();
  m.outils.gitleaks = async (dir) => (dir.endsWith('pub1') || dir.endsWith('pub2') ? 1 : 0);
  await m.run();
  assert.equal(alertes(m.f).length, 2);
});

test('nom de client trouvé -> alerte, le nom n\'est ni dans l\'issue ni dans le journal', async () => {
  const m = monde({ noms: { fichiers: 1, commits: 2 } });
  await m.run();
  const a = alertes(m.f);
  assert.equal(a.length, 1);
  assert.match(a[0].body, /1 fichier\(s\) et 2 message/);
  const tout = JSON.stringify(m.f.etat.issues) + m.journal.join('\n');
  assert.ok(!tout.includes(SECRET_NOM));
  assert.ok(!tout.toLowerCase().includes('zorglub'));
});

test('erreur d\'un outil : alerte « impossible », message d\'erreur jamais recopié, les autres dépôts continuent', async () => {
  const m = monde({ erreur: true });
  const b = await m.run();
  assert.equal(b.impossibles, 1);
  assert.equal(b.depots, 3);
  const tout = JSON.stringify(m.f.etat.issues) + m.journal.join('\n');
  assert.ok(!tout.includes(SECRET_NOM));
  assert.match(alertes(m.f)[0].title, /surveillance impossible sur axion-kit\/pub2/);
});

test('NOMS_CLIENTS absent : gitleaks tourne quand même, la recherche des noms est signalée', async () => {
  const m = monde({ fuites: 1 });
  let appel = 0;
  m.outils.chercherNoms = async () => { appel++; return { fichiers: 9, commits: 9 }; };
  await m.run({ NOMS_CLIENTS: '' });
  assert.equal(appel, 0);
  assert.equal(alertes(m.f).length, 2);   // la fuite + NOMS_CLIENTS absent
  assert.ok(alertes(m.f).some((i) => /NOMS_CLIENTS absent/.test(i.title)));
  assert.ok(m.journal.some((l) => /NOMS_CLIENTS vide/.test(l)));
});

test('recherche réelle des noms dans un vrai dépôt git (arbre et messages), sans afficher le nom', async () => {
  const d = mkdtempSync(join(tmpdir(), 'tg-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', d]);
    writeFileSync(join(d, 'a.txt'), 'bonjour monde\n');
    g('add', '.'); g('commit', '-qm', 'début');
    const outils = outilsReels({});
    assert.deepEqual(await outils.chercherNoms(d, [SECRET_NOM]), { fichiers: 0, commits: 0 });
    writeFileSync(join(d, 'b.txt'), `client ${SECRET_NOM.toUpperCase()}\n`);
    g('add', '.'); g('commit', '-qm', `pour ${SECRET_NOM.toLowerCase()}`);
    assert.deepEqual(await outils.chercherNoms(d, [SECRET_NOM]), { fichiers: 1, commits: 1 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S5 : le nom est cherché dans toutes les références (branche etat) et dans l\'historique (retiré ensuite), sans casse', async () => {
  const d = mkdtempSync(join(tmpdir(), 'tg-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '-b', 'main', d]);
    writeFileSync(join(d, 'a.txt'), 'propre\n');
    g('add', '.'); g('commit', '-qm', 'début');
    const outils = outilsReels({});
    // 1. nom seulement sur la branche etat (HEAD = main, propre)
    g('checkout', '-qb', 'etat');
    writeFileSync(join(d, 'e.txt'), `pour ${SECRET_NOM.toUpperCase()}\n`);
    g('add', '.'); g('commit', '-qm', 'état');
    g('checkout', '-q', 'main');
    assert.deepEqual(await outils.chercherNoms(d, [SECRET_NOM]), { fichiers: 1, commits: 1 });
    // 2. nom ajouté puis retiré sur main : plus dans l'arbre, mais dans l'historique (pickaxe)
    g('branch', '-D', 'etat');
    assert.deepEqual(await outils.chercherNoms(d, [SECRET_NOM]), { fichiers: 0, commits: 0 });
    writeFileSync(join(d, 'c.txt'), `${SECRET_NOM}\n`);
    g('add', '.'); g('commit', '-qm', 'ajout neutre');
    g('rm', '-q', 'c.txt'); g('commit', '-qm', 'retrait neutre');
    assert.deepEqual(await outils.chercherNoms(d, [SECRET_NOM.toLowerCase()]), { fichiers: 0, commits: 2 });
    // caractères spéciaux du nom : littéraux
    assert.deepEqual(await outils.chercherNoms(d, ['a.c+']), { fichiers: 0, commits: 0 });
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test('S3 : gitleaks reçoit --config de kit-pilote et un --gitleaks-ignore-path vide hors du clone ; le .gitleaks.toml du dépôt scanné est sans effet', async () => {
  const racine = mkdtempSync(join(tmpdir(), 'tg3-'));
  try {
    const clone = join(racine, 'clone'); execFileSync('mkdir', [clone]);
    writeFileSync(join(clone, '.gitleaks.toml'), '[allowlist]\npaths = [".*"]\n');
    writeFileSync(join(clone, '.gitleaksignore'), '*\n');
    const faux = join(racine, 'gitleaks');
    // faux binaire : consigne ses arguments et le contenu du dossier d'ignore, trouve « une fuite » si la config n'est pas la bonne
    writeFileSync(faux, `#!/bin/sh\nprintf '%s\\n' "$@" > "${racine}/args"\nwhile [ $# -gt 0 ]; do case "$1" in --gitleaks-ignore-path) ls -A "$2" > "${racine}/ignore-contenu";; esac; shift; done\nexit 0\n`);
    chmodSync(faux, 0o755);
    await outilsReels({ GITLEAKS_BIN: faux }).gitleaks(clone);
    const args = readFileSync(join(racine, 'args'), 'utf8').split('\n');
    const val = (opt) => args[args.indexOf(opt) + 1];
    assert.equal(val('--config'), CONFIG_GITLEAKS);
    assert.ok(!val('--config').startsWith(clone));
    assert.ok(existsSync(CONFIG_GITLEAKS));
    assert.match(readFileSync(CONFIG_GITLEAKS, 'utf8'), /\[extend\]\s*\nuseDefault = true/);
    assert.ok(!val('--gitleaks-ignore-path').startsWith(clone));
    assert.equal(readFileSync(join(racine, 'ignore-contenu'), 'utf8'), '');
    assert.equal(args[0], 'git');                       // « gitleaks git », sur le clone nu
    assert.ok(args.includes('--ignore-gitleaks-allow'));
    assert.ok(!args.includes('detect'));
    assert.equal(args.filter(Boolean).at(-1), clone);
  } finally { rmSync(racine, { recursive: true, force: true }); }
});

test('N2 : exemptions gitleaks dans l\'historique -> G2, alerte avec un nombre, aucun nom de dépôt', async () => {
  const m = monde({ allow: 3 });
  const b = await m.run();
  assert.equal(b.allow, 1);
  assert.ok(m.journal.includes('FUITE possible (code G2)'));
  assert.ok(!m.journal.join('\n').includes('pub2'));
  const a = alertes(m.f);
  assert.equal(a.length, 1);
  assert.match(a[0].title, /exemptions gitleaks dans l'historique de 1 dépôt/);
  assert.ok(!/pub1|pub2|prive1/.test(JSON.stringify(a)));
});

test('N2 : le dépôt pilote lui-même (qui contient ce texte dans son code) n\'est pas compté en G2', async () => {
  const m = monde();
  m.outils.compterAllow = async () => 5;
  const b = await m.run();
  assert.equal(b.allow, 2);             // pub1 et pub2 seulement, pas kit-pilote
});

// ---- intégration avec le VRAI gitleaks (sautée s'il est absent) ----
const GL = process.env.GITLEAKS_BIN || 'gitleaks';
const glDispo = (() => { try { execFileSync(GL, ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('N2 : vrai gitleaks, clone nu : .gitleaksignore et « gitleaks:allow » du dépôt sont sans effet -> 2 fuites', { skip: glDispo ? false : 'gitleaks absent' }, async () => {
  const racine = mkdtempSync(join(tmpdir(), 'tg-int-'));
  try {
    const e = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' };
    const g = (cwd, ...a) => execFileSync('git', a, { cwd, env: e, encoding: 'utf8' });
    const w = join(racine, 'w'); mkdirSync(w);
    g(w, 'init', '-q', '-b', 'main');
    writeFileSync(join(w, 'a.txt'), 'token = "ghp_R8d3kLm2Qx7ZpV1nB5cY9sWt4HfJ6uAeXo0q"  # gitleaks:allow\n');
    writeFileSync(join(w, 'b.txt'), 'aws = "AKIAQ4XJ7RT2MZP5K3WD"\n');
    g(w, 'add', '.'); g(w, 'commit', '-qm', 'secrets factices');
    // empreintes de la 2e fuite, mises dans .gitleaksignore (comme le ferait un attaquant)
    const rep = join(racine, 'r.json');
    try { execFileSync(GL, ['git', '--ignore-gitleaks-allow', '--no-banner', '--exit-code', '2', '-r', rep, '-f', 'json', w], { stdio: 'ignore' }); } catch { /* code 2 attendu */ }
    const empreintes = JSON.parse(readFileSync(rep, 'utf8')).map((x) => x.Fingerprint);
    assert.equal(empreintes.length, 2, 'les 2 secrets factices sont détectés par défaut');
    writeFileSync(join(w, '.gitleaksignore'), empreintes.join('\n') + '\n');
    g(w, 'add', '.'); g(w, 'commit', '-qm', 'ignore');
    // dépôt « distant » nu, cloné par l'outil réel (clone nu : aucun fichier de travail)
    mkdirSync(join(racine, 'srv', 'org'), { recursive: true });
    g(racine, 'clone', '-q', '--bare', w, join(racine, 'srv', 'org', 'cible.git'));
    const outils = outilsReels({ GITLEAKS_BIN: GL, SURVEILLER_URL_BASE: join(racine, 'srv') });
    const dest = join(racine, 'clone');
    await outils.cloner('org', 'cible', dest);
    assert.ok(!existsSync(join(dest, '.gitleaksignore')), 'aucun .gitleaksignore sur disque');
    assert.equal(await outils.gitleaks(dest), 2);
    assert.ok(await outils.compterAllow(dest) >= 1);
  } finally { rmSync(racine, { recursive: true, force: true }); }
});

test('N : recherche des noms insensible aux accents (fichiers, messages, historique), dans les deux sens', async () => {
  const d = mkdtempSync(join(tmpdir(), 'tg-'));
  try {
    const g = (...a) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { stdio: 'pipe' });
    execFileSync('git', ['init', '-q', '-b', 'main', d]);
    writeFileSync(join(d, 'a.txt'), 'propre\n');
    g('add', '.'); g('commit', '-qm', 'début');
    const o = outilsReels({});
    const NOMS = ['Société Générale', 'cafe lumiere', 'A.B+C'];
    assert.deepEqual(await o.chercherNoms(d, NOMS), { fichiers: 0, commits: 0 });
    // fichier : sans accent / majuscules alors que le nom a des accents
    writeFileSync(join(d, 'b.txt'), 'client SOCIETE GENERALE\n');
    g('add', '.'); g('commit', '-qm', 'neutre');
    assert.deepEqual(await o.chercherNoms(d, NOMS), { fichiers: 1, commits: 1 });   // 1 commit : pickaxe
    // fichier avec accents alors que le nom n'en a pas ; message avec accents
    writeFileSync(join(d, 'c.txt'), 'chez Café Lumière\n');
    g('add', '.'); g('commit', '-qm', 'pour CAFÉ LUMIÈRE');
    assert.deepEqual(await o.chercherNoms(d, NOMS), { fichiers: 2, commits: 2 });
    // pas de faux positif : lettres voisines, caractères spéciaux littéraux
    assert.deepEqual(await o.chercherNoms(d, ['Societa Generale', 'A.B+D']), { fichiers: 0, commits: 0 });
  } finally { rmSync(d, { recursive: true, force: true }); }
  assert.ok(motifNom('é').startsWith('(e|E|'));
  assert.ok(motifNom('A.B').includes('\\.'));
});
