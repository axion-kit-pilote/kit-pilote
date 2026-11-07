import { join } from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { executer, codeErreur, appliquerSondes } from '../outils/l7.mjs';
import { verifierArret, verifierEnvironnementProduction, estAncetreDeMain, ErreurGithub, RELECTEUR_ID } from '../src/garde.mjs';
import { fauxCoolify, SHA_A, SHA_B, SHA_C, JETON, URL_C } from './l7-faux-coolify.mjs';

const CONFIG = { outils: { demo: { depot: 'axion-kit/demo', essai: { uuid: 'ess1' }, production: { uuid: 'prd1', db_uuid: 'db1' } }, sansessai: { depot: 'axion-kit/x' } } };
const SONDES_E = JSON.stringify({ demo: 'https://essai.demo.test/sante' });
const SONDES_P = JSON.stringify({ demo: 'https://demo.test/sante' });
const ENV_OK = {
  protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: RELECTEUR_ID } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
  can_admins_bypass: false,
};
const POL_MAIN = { branch_policies: [{ name: 'main', type: 'branch' }] };

// Faux GitHub + faux Coolify dans un seul fetch.
function monde({ apps = {}, bases = {}, env = ENV_OK, pol = POL_MAIN, cmp = { status: 'ahead', merge_base_commit: { sha: SHA_B } }, head = SHA_B, commits = [{ sha: SHA_C, commit: { message: 'Ajoute x' } }], ...reste } = {}) {
  const faux = fauxCoolify({ apps, bases, ...reste });
  const gh = [];
  const f = async (url, opts) => {
    const u = new URL(url);
    if (u.origin !== 'https://api.github.com') return faux.f(url, opts);
    gh.push(u.pathname + u.search);
    const rep = (corps, status = 200) => ({ ok: status < 400, status, json: async () => corps });
    if (u.pathname.endsWith('/environments/production')) return env === null ? rep({}, 404) : rep(env);
    if (u.pathname.endsWith('/deployment-branch-policies')) return rep(pol);
    if (u.pathname.includes('/compare/')) return cmp === null ? rep({}, 404) : rep(cmp);
    if (u.pathname.endsWith('/commits/main')) return rep({ sha: head });
    if (u.pathname.endsWith('/commits')) return rep(commits);
    return rep({}, 404);
  };
  return { f, faux, gh };
}
const baseEnv = (extra = {}) => ({
  COOLIFY_URL_ESSAI: URL_C, COOLIFY_JETON_ESSAI: JETON, COOLIFY_URL_PRODUCTION: URL_C, COOLIFY_JETON_PRODUCTION: JETON,
  SONDES_ESSAI: SONDES_E, SONDES_PRODUCTION: SONDES_P, GITHUB_REPOSITORY: 'axion-kit-pilote/kit-pilote', OUTIL: 'demo', SHA: SHA_B, ...extra,
});
const lancer = async (cmd, env, m, config = CONFIG) => {
  const sortie = []; const resumes = [];
  const code = await executer(cmd, env, { fetch: m.f, config, dire: (x) => sortie.push(x), resume: (x) => resumes.push(x) });
  return { code, sortie, resumes };
};
const appsEssaiOk = () => ({ ess1: { git_commit_sha: SHA_B, status: 'running:healthy' } });

// --- P3 : gardes de l'environnement production ---
test('P3 : environnement conforme accepté', async () => {
  const gh = async (p) => (p.endsWith('policies') ? POL_MAIN : ENV_OK);
  assert.deepEqual(await verifierEnvironnementProduction(gh, 'axion-kit-pilote/kit-pilote'), { ok: true, code: 'OK' });
});
for (const [nom, env, pol, code] of [
  ['administrateurs peuvent contourner', { ...ENV_OK, can_admins_bypass: true }, POL_MAIN, 'ENV_CONTOURNEMENT_ADMIN'],
  ['contournement non précisé', { ...ENV_OK, can_admins_bypass: undefined }, POL_MAIN, 'ENV_CONTOURNEMENT_ADMIN'],
  ['sans protection_rules', { ...ENV_OK, protection_rules: [] }, POL_MAIN, 'ENV_RELECTEUR_INCORRECT'],
  ['autre relecteur', { ...ENV_OK, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: 1 } }] }] }, POL_MAIN, 'ENV_RELECTEUR_INCORRECT'],
  ['relecteur supplémentaire', { ...ENV_OK, protection_rules: [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { id: RELECTEUR_ID } }, { type: 'User', reviewer: { id: 7 } }] }] }, POL_MAIN, 'ENV_RELECTEUR_INCORRECT'],
  ['règle d\'attente seule', { ...ENV_OK, protection_rules: [{ type: 'wait_timer' }] }, POL_MAIN, 'ENV_RELECTEUR_INCORRECT'],
  ['sans politique de branches', { ...ENV_OK, deployment_branch_policy: null }, POL_MAIN, 'ENV_BRANCHES_NON_LIMITEES'],
  ['toutes les branches protégées', { ...ENV_OK, deployment_branch_policy: { protected_branches: true, custom_branch_policies: false } }, POL_MAIN, 'ENV_BRANCHES_NON_LIMITEES'],
  ['branches personnalisées mais pas main seule', ENV_OK, { branch_policies: [{ name: 'main' }, { name: 'dev' }] }, 'ENV_BRANCHES_NON_LIMITEES'],
  ['branche autre que main', ENV_OK, { branch_policies: [{ name: 'dev' }] }, 'ENV_BRANCHES_NON_LIMITEES'],
  ['motif de branche', ENV_OK, { branch_policies: [{ name: 'main', type: 'tag' }] }, 'ENV_BRANCHES_NON_LIMITEES'],
]) {
  test(`P3 : environnement refusé — ${nom}`, async () => {
    const gh = async (p) => (p.endsWith('policies') ? pol : env);
    assert.deepEqual(await verifierEnvironnementProduction(gh, 'axion-kit-pilote/kit-pilote'), { ok: false, code });
  });
}
test('P3 : environnement absent (404) = erreur à code fixe, dépôt pilote inconnu refusé', async () => {
  const gh = async () => { throw new ErreurGithub(404); };
  await assert.rejects(verifierEnvironnementProduction(gh, 'a/b'), (e) => e.code === 'ERREUR_GITHUB_404');
  assert.equal((await verifierEnvironnementProduction(gh, undefined)).code, 'PILOTE_INCONNU');
});
test('P3 : ARRET=oui refuse (casse et espaces ignorés), autre valeur accepte', () => {
  for (const v of ['oui', 'OUI', ' oui ']) assert.equal(verifierArret(v).ok, false);
  for (const v of [undefined, '', 'non', 'ouiii']) assert.equal(verifierArret(v).ok, true);
});
test('P3/P10 : ancêtre de main exigé (ahead/identical + base de fusion = SHA)', async () => {
  const mk = (cmp) => async () => cmp;
  assert.equal(await estAncetreDeMain(mk({ status: 'ahead', merge_base_commit: { sha: SHA_B } }), 'a/b', SHA_B), true);
  assert.equal(await estAncetreDeMain(mk({ status: 'identical', merge_base_commit: { sha: SHA_B } }), 'a/b', SHA_B), true);
  assert.equal(await estAncetreDeMain(mk({ status: 'diverged', merge_base_commit: { sha: SHA_A } }), 'a/b', SHA_B), false);
  assert.equal(await estAncetreDeMain(mk({ status: 'behind', merge_base_commit: { sha: SHA_B } }), 'a/b', SHA_B), false);
  assert.equal(await estAncetreDeMain(mk({ status: 'ahead', merge_base_commit: { sha: SHA_A } }), 'a/b', SHA_B), false);
  assert.equal(await estAncetreDeMain(mk({ status: 'ahead' }), 'a/b', SHA_B), false);
});

// --- Lanceur : verifier-essai ---
test('verifier-essai : tout est conforme -> code 0 et résumé', async () => {
  const m = monde({ apps: appsEssaiOk() });
  const r = await lancer('verifier-essai', baseEnv(), m);
  assert.equal(r.code, 0);
  assert.match(r.resumes[0], /Issue de main : oui/);
  assert.match(r.resumes[0], /sauvegarde à la demande/);
});
test('verifier-essai : ARRET=oui -> 1 sans appel GitHub ni Coolify', async () => {
  const m = monde({ apps: appsEssaiOk() });
  const r = await lancer('verifier-essai', baseEnv({ ARRET: 'oui' }), m);
  assert.equal(r.code, 1); assert.deepEqual(r.sortie, ['ARRET']);
  assert.equal(m.gh.length + m.faux.appels.length, 0);
});
test('verifier-essai : environnement non conforme -> 1', async () => {
  const m = monde({ apps: appsEssaiOk(), env: { ...ENV_OK, protection_rules: [] } });
  assert.equal((await lancer('verifier-essai', baseEnv(), m)).code, 1);
});
test('verifier-essai : SHA qui n\'est pas ancêtre de main -> 1, l\'essai n\'est même pas consulté', async () => {
  const m = monde({ apps: appsEssaiOk(), cmp: { status: 'diverged', merge_base_commit: { sha: SHA_A } } });
  const r = await lancer('verifier-essai', baseEnv(), m);
  assert.equal(r.code, 1); assert.ok(r.sortie.includes('FILIATION KO'));
  assert.equal(m.faux.appels.length, 0);
});
test('verifier-essai : essai en échec -> 1', async () => {
  const m = monde({ apps: { ess1: { git_commit_sha: SHA_B, status: 'running:healthy', sert: SHA_A, deploiements: [{ status: 'finished', commit: SHA_A, created_at: 1 }] } } });
  const r = await lancer('verifier-essai', baseEnv(), m);
  assert.equal(r.code, 1); assert.ok(r.sortie.includes('ESSAI SHA_NON_DEPLOYE_SUR_ESSAI'));
});
test('DEPUIS : validé (40 hexa) puis utilisé pour la comparaison', async () => {
  let m = monde({ apps: appsEssaiOk() });
  assert.equal((await lancer('verifier-essai', baseEnv({ DEPUIS: 'main; rm -rf' }), m)).code, 1);
  assert.equal(m.gh.length, 0);
  m = monde({ apps: appsEssaiOk(), cmp: { status: 'ahead', merge_base_commit: { sha: SHA_B }, commits: [{ sha: SHA_C, commit: { message: 'Depuis x' } }] } });
  const r = await lancer('verifier-essai', baseEnv({ DEPUIS: SHA_A }), m);
  assert.equal(r.code, 0);
  assert.ok(m.gh.some((p) => p === `/repos/axion-kit/demo/compare/${SHA_A}...${SHA_B}`));
  assert.match(r.resumes[0], /Depuis x/);
});
test('verifier-essai : outil inconnu / SHA invalide -> exception à code fixe', async () => {
  const m = monde();
  await assert.rejects(lancer('verifier-essai', baseEnv({ OUTIL: 'constructor' }), m), (e) => codeErreur(e) === 'OUTIL_INCONNU');
  await assert.rejects(lancer('verifier-essai', baseEnv({ SHA: 'main' }), m), (e) => codeErreur(e) === 'SHA_INVALIDE');
});

// --- Lanceur : liberer ---
test('liberer : sauvegarde puis production, code 0', async () => {
  const m = monde({ apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } }, bases: { db1: { sauvegarde: 'success' } } });
  const r = await lancer('liberer', baseEnv(), m);
  assert.equal(r.code, 0); assert.equal(m.faux.bases.db1.declenchee, 1);
  assert.equal(m.faux.apps.prd1.sert, SHA_B);
});
test('liberer : sauvegarde en échec -> code 1, rien déployé', async () => {
  const m = monde({ apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } }, bases: { db1: { sauvegarde: 'failed' } } });
  const r = await lancer('liberer', baseEnv(), m);
  assert.equal(r.code, 1); assert.ok(r.sortie.includes('SAUVEGARDE_KO'));
  assert.equal(m.faux.apps.prd1.sert, SHA_A);
});
test('liberer : sans base déclarée, le résumé le dit', async () => {
  const cfg = { outils: { demo: { ...CONFIG.outils.demo, production: { uuid: 'prd1' } } } };
  const m = monde({ apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
  const r = await lancer('liberer', baseEnv(), m, cfg);
  assert.equal(r.code, 0); assert.match(r.resumes[0], /Pas de base de données déclarée/);
});
test('liberer : ARRET=oui -> 1 et aucun appel', async () => {
  const m = monde({ apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
  assert.equal((await lancer('liberer', baseEnv({ ARRET: 'oui' }), m)).code, 1);
  assert.equal(m.faux.appels.length, 0);
});
test('liberer : échec de santé -> code 1 avec retour arrière', async () => {
  const apps = { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } };
  const m = monde({ apps, bases: { db1: { sauvegarde: 'success' } }, sante: (u, a) => a.prd1.git_commit_sha !== SHA_B });
  const r = await lancer('liberer', baseEnv(), m);
  assert.equal(r.code, 1); assert.match(r.resumes[0], /retour arrière réussi/);
});
test('commande inconnue -> 2', async () => {
  assert.equal((await lancer('autre', baseEnv(), monde())).code, 2);
});

// --- Lanceur : essai (P10 et mineurs) ---
test('P10 : essai avec SHA sans OUTIL refusé (code 2), rien d\'appelé', async () => {
  const m = monde({ apps: appsEssaiOk() });
  const r = await lancer('essai', baseEnv({ OUTIL: '', SHA: SHA_B }), m);
  assert.equal(r.code, 2); assert.deepEqual(r.sortie, ['SHA_SANS_OUTIL']);
  assert.equal(m.gh.length + m.faux.appels.length, 0);
});
test('P10 : essai avec SHA non hexadécimal refusé', async () => {
  const m = monde();
  assert.equal((await lancer('essai', baseEnv({ SHA: 'main' }), m)).code, 2);
});
test('P10 : essai avec SHA hors main (non ancêtre) refusé, rien déployé', async () => {
  const m = monde({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } }, cmp: { status: 'diverged', merge_base_commit: { sha: SHA_A } } });
  const r = await lancer('essai', baseEnv(), m);
  assert.equal(r.code, 1); assert.ok(r.sortie.includes('[demo] FILIATION_KO'));
  assert.ok(!m.faux.appels.some((a) => a.methode !== 'GET'));
});
test('essai : SHA ancêtre de main déployé ; sans SHA = tête de main ; code 0', async () => {
  let m = monde({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
  assert.equal((await lancer('essai', baseEnv(), m)).code, 0);
  assert.equal(m.faux.apps.ess1.sert, SHA_B);
  m = monde({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } }, head: SHA_C });
  assert.equal((await lancer('essai', baseEnv({ OUTIL: '', SHA: '' }), m)).code, 0);
  assert.equal(m.faux.apps.ess1.sert, SHA_C);
});
test('essai : déploiement en échec -> code 1', async () => {
  const m = monde({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } }, deploiementEchoue: (s) => s === SHA_B });
  assert.equal((await lancer('essai', baseEnv(), m)).code, 1);
});
test('mineur : outil demandé sans essai -> code 1 ; en mode « tous », ignoré avec journal', async () => {
  const m = monde({ apps: appsEssaiOk() });
  assert.equal((await lancer('essai', baseEnv({ OUTIL: 'sansessai', SHA: '' }), m)).code, 1);
  const tous = await lancer('essai', baseEnv({ OUTIL: '', SHA: '' }), monde({ apps: appsEssaiOk() }));
  assert.equal(tous.code, 0); assert.ok(tous.sortie.includes('[sansessai] ESSAI_NON_CONFIGURE'));
});

// --- P4 : journaux muets ---
test('P4 : codeErreur ne renvoie que des codes fixes, jamais un message', async () => {
  assert.equal(codeErreur(new Error(`secret ${JETON} ${URL_C}`)), 'ERREUR_INTERNE');
  assert.equal(codeErreur({ code: `contient ${JETON}` }), 'ERREUR_INTERNE');
  const m = monde({ apps: { ess1: {} }, fuiteJeton: true });
  await assert.rejects(lancer('essai', baseEnv(), m), (e) => {
    const c = codeErreur(e);
    assert.match(c, /^ERREUR_COOLIFY_(500|404)$/);
    assert.ok(!c.includes(JETON) && !c.includes(URL_C));
    return true;
  });
  const gh500 = { f: async () => ({ ok: false, status: 502, json: async () => ({}) }) };
  await assert.rejects(executer('essai', baseEnv({ SHA: '' }), { fetch: gh500.f, config: CONFIG, dire: () => {} }), (e) => codeErreur(e) === 'ERREUR_GITHUB_502');
  const reseau = async () => { throw new Error(`boom ${JETON}`); };
  await assert.rejects(executer('essai', baseEnv({ SHA: '' }), { fetch: reseau, config: CONFIG, dire: () => {} }), (e) => codeErreur(e) === 'ERREUR_GITHUB_RESEAU');
});
test('P4 : le point d\'entrée n\'imprime que le code (processus réel)', async () => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, ['outils/l7.mjs', 'verifier-essai'], { env: { PATH: process.env.PATH, OUTIL: 'secret-outil-xyz', SHA: SHA_B }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), 'OUTIL_INCONNU');
  assert.ok(!r.stdout.includes('secret-outil-xyz') && !r.stderr.includes('secret-outil-xyz'));
});

// --- P5 : aucune URL dans le dépôt ---
test('P5 : coolify/outils.json sans URL ni domaine ; sondes lues dans l\'environnement', () => {
  const t = readFileSync(new URL('../coolify/outils.json', import.meta.url), 'utf8');
  assert.ok(!/https?:|:\/\/|\.[a-z]{2,}\b(?!")/i.test(t.replace(/"[\w-]+\/[\w.-]+"/g, '""')), t);
  const o = appliquerSondes({ nom: 'demo', essai: { uuid: 'e' }, production: { uuid: 'p', sonde: 'https://dans-le-depot.test' } }, { SONDES_ESSAI: SONDES_E, SONDES_PRODUCTION: '{"autre":"https://x"}' });
  assert.equal(o.essai.sonde, 'https://essai.demo.test/sante');
  assert.equal(o.production.sonde, undefined); // l'URL du dépôt est ignorée
  assert.equal(appliquerSondes({ nom: 'constructor', essai: { uuid: 'e' } }, { SONDES_ESSAI: '{}' }).essai.sonde, undefined);
});
test('P5 : aucun fichier suivi du dépôt (hors tests/docs d\'exemple) ne contient de domaine de production', () => {
  for (const d of ['../src/', '../outils/', '../coolify/']) {
    for (const e of readdirSync(new URL(d, import.meta.url), { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue;
      const nom = e.name;
      const t = readFileSync(join(e.parentPath ?? e.path, nom), 'utf8').replace(/\\+\./g, '.'); // « github\\.com » dans une expression régulière = github.com
      for (const m of t.matchAll(/https?:\/\/([\w.-]+)/g)) assert.ok(['github.com', 'api.github.com'].includes(m[1]), `${nom}: ${m[1]}`);
    }
  }
});

// --- P9 : le jeton de production n'existe que dans un job « environment: production » ---
test('P9 : COOLIFY_*_PRODUCTION et SONDES_PRODUCTION seulement dans un job environment: production', () => {
  const dir = new URL('../.github/workflows/', import.meta.url);
  const interdits = /COOLIFY_JETON_PRODUCTION|COOLIFY_URL_PRODUCTION|SONDES_PRODUCTION/;
  let vus = 0;
  for (const nom of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    const lignes = readFileSync(new URL(nom, dir), 'utf8').split('\n');
    const iJobs = lignes.findIndex((l) => /^jobs:\s*$/.test(l));
    lignes.forEach((l, i) => {
      if (!interdits.test(l)) return;
      vus++;
      assert.ok(iJobs >= 0 && i > iJobs, `${nom}:${i + 1} hors d'un job`);
      let debut = i; while (debut > iJobs && !/^  [\w-]+:\s*$/.test(lignes[debut])) debut--;
      let fin = i + 1; while (fin < lignes.length && !/^  [\w-]+:\s*$/.test(lignes[fin])) fin++;
      const job = lignes.slice(debut, fin).join('\n');
      assert.match(job, /^\s{4}environment:\s*production\s*$/m, `${nom}:${i + 1} job sans environment: production`);
      assert.ok(!/environment:\s*(?!production\b)\S/.test(job), `${nom}:${i + 1} autre environnement dans le même job`);
    });
  }
  assert.ok(vus >= 3, 'le test doit voir les secrets de production');
});
test('P9 : le test détecte une fuite (job sans environnement)', () => {
  const faux = 'jobs:\n  a:\n    runs-on: x\n    steps:\n      - env:\n          COOLIFY_JETON_PRODUCTION: z\n';
  const l = faux.split('\n'); const i = l.findIndex((x) => /COOLIFY_JETON_PRODUCTION/.test(x));
  let d = i; while (!/^  [\w-]+:\s*$/.test(l[d])) d--;
  assert.ok(!/^\s{4}environment:\s*production\s*$/m.test(l.slice(d).join('\n')));
});

test('mineur : un seul groupe de concurrence par application ; garde-fous du job verifier', () => {
  const e = readFileSync(new URL('../.github/workflows/essai.yml', import.meta.url), 'utf8');
  const l = readFileSync(new URL('../.github/workflows/liberer.yml', import.meta.url), 'utf8');
  assert.match(e, /group: essai\b/); assert.ok(!/group:.*inputs/.test(e));
  assert.match(l, /group: production-\$\{\{ inputs\.outil \}\}/);
  assert.match(l, /ARRET: \$\{\{ vars\.ARRET \}\}/);
  assert.match(l, /actions: read/);
});
