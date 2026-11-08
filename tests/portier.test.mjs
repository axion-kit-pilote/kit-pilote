import test from 'node:test';
import assert from 'node:assert/strict';
import { cycle } from '../src/portier.mjs';
import { porte } from '../src/porte.mjs';
import { motifCorrespondant, parserMotifs } from '../src/lib.mjs';
import { validerNom, validerDescription, corpsProtection, creer } from '../outils/kit-nouveau.mjs';
import { readFileSync } from 'node:fs';
import { APP, JETON_APP, JETON_PILOTE, PILOTE, sha, creerDepot, ajouterPr, creerFake } from './fake.mjs';

const H = sha('a');
const env = (extra = {}) => ({ GH_TOKEN: JETON_APP, PILOTE_TOKEN: JETON_PILOTE, PORTIER_APP_ID: APP, GITHUB_REPOSITORY: PILOTE, ...extra });
async function lancer(fake, extra = {}) {
  const journal = [];
  const r = await cycle({ env: env(extra), fetchImpl: fake.fetch, log: (l) => journal.push(l) });
  return { ...r, journal: journal.join('\n') };
}
function monde(prOpts, depotOpts = {}, nom = 'projet') {
  const d = creerDepot(nom, depotOpts);
  ajouterPr(d, 1, prOpts);
  return { d, fake: creerFake({ depots: [d] }) };
}

test('PR verte non sensible : contrôle success puis fusion avec le bon sha', async () => {
  const { d, fake } = monde({});
  const r = await lancer(fake);
  assert.equal(r.erreurs, 0);
  assert.deepEqual(d.merges, [{ pr: 1, sha: H, merge_method: 'merge' }]);
  assert.equal(d.checks[0].name, 'portier');
  assert.equal(d.checks[0].conclusion, 'success');
  assert.equal(d.checks[0].head_sha, H);
  assert.ok(!r.journal.includes(JETON_APP) && !r.journal.includes(JETON_PILOTE));
});

test('PR sensible : pas de fusion, contrôle en cours « attente Will », dispatch unique', async () => {
  const { d, fake } = monde({ fichiers: [{ filename: '.github/workflows/ci.yml', status: 'modified' }] });
  await lancer(fake);
  await lancer(fake);
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(d.checks.length, 1);
  assert.equal(d.checks[0].status, 'in_progress');
  assert.equal(d.checks[0].output.title, 'attente Will');
  assert.deepEqual(fake.etat.dispatches, [{ ref: 'main', inputs: { repo: 'axion-kit/projet', pr: '1', sha: H } }]);
});

test('tête changée entre lecture et fusion : pas de fusion (relecture)', async () => {
  const { d, fake } = monde({});
  d.pulls[1].tetes = [H, sha('b')];
  await lancer(fake);
  assert.equal(d.merges.length, 0);
});

test('tête changée après la relecture : GitHub refuse (409), pas de fusion', async () => {
  const { d, fake } = monde({});
  d.pulls[1].reelle = sha('b');
  const r = await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.match(r.journal, /non fusionnée/);
});

test('CI rouge ou en attente sur la PR : rien', async () => {
  for (const ci of ['failure', 'attente', null]) {
    const { d, fake } = monde({ ci });
    await lancer(fake);
    assert.equal(d.merges.length, 0);
    assert.equal(d.checks.length, 0);
  }
});

test('dernière CI de main rouge : rien', async () => {
  const { d, fake } = monde({}, { mainCi: 'failure' });
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(d.checks.length, 0);
});

test('protection absente, app_id faux ou enforce_admins off : alerte unique et dépôt ignoré', async () => {
  const cas = [
    null,
    { required_status_checks: { checks: [{ context: 'portier', app_id: 999 }] }, enforce_admins: { enabled: true } },
    { required_status_checks: { checks: [{ context: 'portier', app_id: Number(APP) }] }, enforce_admins: { enabled: false } },
    { required_status_checks: { contexts: ['portier'] }, enforce_admins: { enabled: true } },
  ];
  for (const protection of cas) {
    const { d, fake } = monde({}, { protection });
    await lancer(fake);
    await lancer(fake);
    assert.equal(d.merges.length, 0);
    assert.equal(d.checks.length, 0);
    assert.equal(fake.etat.issues.length, 1);
    assert.match(fake.etat.issues[0].title, /axion-kit\/projet/);
  }
});

test('ARRET=oui : aucun appel', async () => {
  const { d, fake } = monde({});
  await lancer(fake, { ARRET: 'oui' });
  assert.equal(fake.etat.appels.length, 0);
  assert.equal(d.merges.length, 0);
});

test('PR depuis un fork : ignorée', async () => {
  const { d, fake } = monde({ fork: true });
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(d.checks.length, 0);
  assert.equal(fake.etat.dispatches.length, 0);
});

test('dépôt sans le sujet kit-projet ou archivé : ignoré', async () => {
  const a = monde({}, { topics: [] });
  await lancer(a.fake);
  assert.equal(a.d.merges.length, 0);
  const b = monde({}, { archived: true });
  await lancer(b.fake);
  assert.equal(b.d.merges.length, 0);
});

test('suppression ou renommage d\'un test : sensible', async () => {
  for (const f of [
    { filename: 'src/a.test.js', status: 'removed' },
    { filename: 'src/b.js', previous_filename: 'src/b.spec.js', status: 'renamed' },
    { filename: 'tests/c.js', status: 'removed' },
  ]) {
    const { d, fake } = monde({ fichiers: [f] });
    await lancer(fake);
    assert.equal(d.merges.length, 0, JSON.stringify(f));
    assert.equal(fake.etat.dispatches.length, 1);
  }
});

test('ajout ou modification d\'un test : non sensible', async () => {
  const { d } = monde({ fichiers: [{ filename: 'src/a.test.js', status: 'modified' }] });
  const fake = creerFake({ depots: [d] });
  await lancer(fake);
  assert.equal(d.merges.length, 1);
});

const anodins = (n) => Array.from({ length: n }, (_, i) => ({ filename: `src/f${i}.js`, status: 'added' }));
test('B1 : 300 fichiers ou plus dans le compare : sensible (l\'API tronque à 300)', async () => {
  const { d, fake } = monde({ fichiers: anodins(300) });
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(fake.etat.dispatches.length, 1);
});

test('B1 : 299 fichiers anodins, paginés : fusion', async () => {
  const { d, fake } = monde({ fichiers: anodins(299) });
  await lancer(fake);
  assert.equal(d.merges.length, 1);
});

test('B1 : la liste vient du compare épinglé sur H, pas de /pulls/n/files (course force-push)', async () => {
  // /files « du moment » montre une tête anodine ; le compare à H montre le fichier sensible.
  const { d, fake } = monde({
    fichiers: [{ filename: '.github/workflows/ci.yml', status: 'modified' }],
    fichiersFiles: [{ filename: 'src/app.js', status: 'modified' }],
  });
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(fake.etat.dispatches.length, 1);
  assert.ok(fake.etat.appels.some((a) => a.includes(`/compare/${sha('0')}...${H}`)), 'compare base.sha...H');
  assert.ok(!fake.etat.appels.some((a) => a.endsWith('/files')), 'plus d\'appel à /files');
});

test('B1 : tête changée juste avant le feu vert : aucun contrôle success posé', async () => {
  const { d, fake } = monde({});
  d.pulls[1].tetes = [H, sha('b')];
  await lancer(fake);
  assert.equal(d.checks.length, 0);
  assert.equal(d.merges.length, 0);
});

// Décision du 08/11/2026 (méthode de la comptabilité) : une PR en retard sur main n'est plus mise à jour avant fusion.
test('I1 : PR en retard sur main et fusionnable : fusion directe à H, sans mise à jour', async () => {
  const { d, fake } = monde({ retard: 2 });
  const r = await lancer(fake);
  assert.equal(r.erreurs, 0);
  assert.equal(d.majs, undefined);
  assert.deepEqual(d.merges, [{ pr: 1, sha: H, merge_method: 'merge' }]);
  assert.equal(d.checks[0].conclusion, 'success');
  assert.equal(d.checks[0].head_sha, H);
  assert.match(r.journal, /fusionnée/);
});

test('I1 : PR en retard, fusionnabilité pas encore calculée (null) : attente, ni fusion ni contrôle ni mise à jour', async () => {
  const { d, fake } = monde({ retard: 2 });
  d.pulls[1].mergeable = null;
  const r = await lancer(fake);
  assert.equal(r.erreurs, 0);
  assert.equal(d.merges.length, 0);
  assert.equal(d.checks.length, 0);
  assert.equal(d.majs, undefined);
  assert.match(r.journal, /fusionnabilité inconnue, au prochain cycle/);
});

test('I1 : PR en retard avec conflit (mergeable false) : attente, ni mise à jour, ni fusion, ni erreur', async () => {
  const { d, fake } = monde({ retard: 2 });
  d.pulls[1].conflit = true;
  const r = await lancer(fake);
  assert.equal(r.erreurs, 0);
  assert.equal(d.merges.length, 0);
  assert.equal(d.checks.length, 0);
  assert.equal(d.majs, undefined);
  assert.match(r.journal, /en conflit avec main : en attente/);
});

test('PR à jour avec main : fusionnée même si la fusionnabilité est inconnue (règle inchangée)', async () => {
  const { d, fake } = monde({});
  d.pulls[1].mergeable = null;
  await lancer(fake);
  assert.equal(d.merges.length, 1);
});

test('I1 : PR en retard, tête changée avant la fusion : GitHub refuse (409), pas de fusion', async () => {
  const { d, fake } = monde({ retard: 2 });
  d.pulls[1].reelle = sha('c');
  const r = await lancer(fake);
  assert.equal(d.majs, undefined);
  assert.equal(d.merges.length, 0);
  assert.match(r.journal, /non fusionnée/);
});

const fichiersSensibles = [{ filename: '.github/workflows/ci.yml', status: 'modified' }];
test('I1 : PR sensible en retard, tête changée (422) : rien, en attente', async () => {
  const { d, fake } = monde({ retard: 2, fichiers: fichiersSensibles });
  d.pulls[1].reelle = sha('c');
  const r = await lancer(fake);
  assert.equal(r.erreurs, 0);
  assert.equal(d.majs, undefined);
  assert.equal(d.merges.length, 0);
  assert.equal(fake.etat.dispatches.length, 0);
  assert.match(r.journal, /mise à jour impossible/);
});

test('I1 : PR sensible en retard, mise à jour refusée pour une autre raison (403) : erreur comptée', async () => {
  const { d, fake } = monde({ retard: 2, fichiers: fichiersSensibles });
  d.pulls[1].majStatut = 403;
  const r = await lancer(fake);
  assert.ok(r.erreurs >= 1);
  assert.equal(d.majs, undefined);
  assert.equal(d.merges.length, 0);
});

test('I1 : PR en retard et brouillon : aucune mise à jour', async () => {
  const { d, fake } = monde({ retard: 2 });
  d.pulls[1].draft = true;
  await lancer(fake);
  assert.equal(d.majs, undefined);
  assert.equal(d.merges.length, 0);
});

test('I1 : PR en retard depuis un fork : aucune mise à jour', async () => {
  const { d, fake } = monde({ retard: 2, fork: true });
  await lancer(fake);
  assert.equal(d.majs, undefined);
  assert.equal(d.merges.length, 0);
});

test('I1 : PR sensible en retard : mise à jour seule (la porte refuse une PR en retard), ni contrôle ni demande à Will', async () => {
  const { d, fake } = monde({ retard: 2, fichiers: fichiersSensibles });
  const r = await lancer(fake);
  assert.equal(d.majs.length, 1);
  assert.equal(d.majs[0].expected_head_sha, H);
  assert.equal(d.checks.length, 0);
  assert.equal(d.merges.length, 0);
  assert.equal(fake.etat.dispatches.length, 0);
  assert.match(r.journal, /mise à jour demandée avant l'accord de Will/);
});

test('I1 : seul un run ci.yml pull_request de ce dépôt, à H, lié à la PR, compte', async () => {
  const mauvais = [
    { event: 'push' },
    { event: 'workflow_dispatch' },
    { path: '.github/workflows/autre.yml' },
    { repository: { full_name: 'autre/projet' } },
    { head_repository: { full_name: 'autre/fork' } },
    { pull_requests: [{ number: 99 }] },
    { pull_requests: [] },
    { head_sha: sha('c') },
  ];
  for (const m of mauvais) {
    const { d, fake } = monde({ ci: [{ etat: 'success', ...m }] });
    await lancer(fake);
    assert.equal(d.merges.length, 0, JSON.stringify(m));
    assert.equal(d.checks.length, 0, JSON.stringify(m));
  }
});

test('I1 : un run valide parmi des faux ne suffit pas si le plus récent valide est rouge', async () => {
  const t = (n) => new Date(2e12 + n * 1000).toISOString();
  const a = monde({ ci: [{ etat: 'success', created_at: t(1) }, { etat: 'failure', created_at: t(2) }, { etat: 'success', event: 'push', created_at: t(3) }] });
  await lancer(a.fake);
  assert.equal(a.d.merges.length, 0);
  const b = monde({ ci: [{ etat: 'failure', created_at: t(1) }, { etat: 'success', created_at: t(2) }] });
  await lancer(b.fake);
  assert.equal(b.d.merges.length, 1);
});

test('I1 : CI de main : seuls les runs event=push du bon chemin et du dépôt comptent', async () => {
  for (const m of [{ event: 'pull_request' }, { event: 'workflow_dispatch' }, { path: '.github/workflows/x.yml' }, { repository: { full_name: 'autre/projet' } }, { head_branch: 'feature' }]) {
    const { d, fake } = monde({}, { mainCi: [{ etat: 'success', ...m }] });
    await lancer(fake);
    assert.equal(d.merges.length, 0, JSON.stringify(m));
  }
});

test('M5 : motif *.config.* (vitest/eslint/playwright) : sensible', async () => {
  for (const f of ['vitest.config.ts', 'apps/web/eslint.config.mjs', 'playwright.config.js']) {
    const { d, fake } = monde({ fichiers: [{ filename: f, status: 'modified' }] });
    await lancer(fake);
    assert.equal(d.merges.length, 0, f);
    assert.equal(fake.etat.dispatches.length, 1, f);
  }
});

test('M5 : renommage depuis un chemin sensible : sensible', async () => {
  const { d, fake } = monde({ fichiers: [{ filename: 'docs/ci.txt', previous_filename: '.github/workflows/ci.yml', status: 'renamed' }] });
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(fake.etat.dispatches.length, 1);
});

test('M3 : suppression de tests e2e, cypress, playwright : sensible', async () => {
  for (const f of ['e2e/login.js', 'src/login.e2e.ts', 'cypress/a.js', 'playwright/b.js']) {
    const { d, fake } = monde({ fichiers: [{ filename: f, status: 'removed' }] });
    await lancer(fake);
    assert.equal(d.merges.length, 0, f);
  }
});

test('B3 : le jeton axion-kit est refusé sur axion-kit-pilote ; dispatch et issues passent par PILOTE_TOKEN', async () => {
  const fake0 = creerFake({ depots: [] });
  const refus = await fake0.fetch(`https://api.github.com/repos/${PILOTE}/issues`, { method: 'POST', headers: { Authorization: `Bearer ${JETON_APP}` }, body: '{}' });
  assert.equal(refus.status, 403);
  const a = monde({ fichiers: [{ filename: 'package.json', status: 'modified' }] });
  const r = await lancer(a.fake);
  assert.equal(r.erreurs, 0, r.journal);
  assert.equal(a.fake.etat.dispatches.length, 1);
  const b = monde({}, { protection: null });
  await lancer(b.fake);
  assert.equal(b.fake.etat.issues.length, 1);
  // PILOTE_TOKEN absent : refus net
  await assert.rejects(cycle({ env: env({ PILOTE_TOKEN: '' }), fetchImpl: a.fake.fetch, log() {} }), /PILOTE_TOKEN/);
});

test('M1 : marqueur posé AVANT le dispatch, retiré si le dispatch échoue', async () => {
  const { d, fake } = monde({ fichiers: [{ filename: 'package.json', status: 'modified' }] });
  fake.etat.dispatchEchec = true;
  const r = await lancer(fake);
  assert.deepEqual(fake.etat.marqueurs, [true]);
  assert.equal(r.erreurs, 1);
  assert.ok(!d.checks[0].external_id, 'marqueur retiré');
  fake.etat.dispatchEchec = false;
  await lancer(fake);
  assert.equal(fake.etat.dispatches.length, 1);
  assert.equal(d.checks[0].external_id, `dispatch:${H}`);
});

test('M2 : ARRET tolère espaces et casse', async () => {
  for (const v of [' OUI ', 'Oui', 'oui\n']) {
    const { d, fake } = monde({});
    await lancer(fake, { ARRET: v });
    assert.equal(fake.etat.appels.length, 0, v);
    assert.equal(d.merges.length, 0);
  }
});

test('I5 : force-push ou suppression autorisés, ruleset avec bypass : alerte, dépôt ignoré', async () => {
  const ok = creerDepot('x').protection;
  const cas = [
    { protection: { ...ok, allow_force_pushes: { enabled: true } } },
    { protection: { ...ok, allow_deletions: { enabled: true } } },
    { protection: { ...ok, allow_force_pushes: undefined } },
    { rules: [{ ruleset_id: 7, ruleset_source_type: 'Repository', type: 'deletion' }], rulesets: { 7: { bypass_actors: [{ actor_id: 1, actor_type: 'RepositoryRole' }] } } },
    { rules: [{ ruleset_id: 8, ruleset_source_type: 'Repository', type: 'deletion' }], rulesets: {} },
  ];
  for (const opts of cas) {
    const { d, fake } = monde({}, opts);
    await lancer(fake);
    assert.equal(d.merges.length, 0, JSON.stringify(opts));
    assert.equal(fake.etat.issues.length, 1, JSON.stringify(opts));
  }
  const sans = monde({}, { rules: [{ ruleset_id: 7, ruleset_source_type: 'Repository', type: 'deletion' }], rulesets: { 7: { bypass_actors: [] } } });
  await lancer(sans.fake);
  assert.equal(sans.d.merges.length, 1);
});

test('M4 : tête sans sha dans la PR : pas de plantage, refus propre', async () => {
  const { d, fake } = monde({ sansSha: true });
  const r = await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(r.erreurs, 0);
});

test('kit-modele : toujours sensible', async () => {
  const { d, fake } = monde({}, {}, 'kit-modele');
  await lancer(fake);
  assert.equal(d.merges.length, 0);
  assert.equal(fake.etat.dispatches.length, 1);
});

test('motifs glob de chemins-sensibles.txt', () => {
  const m = parserMotifs(readFileSync(new URL('../chemins-sensibles.txt', import.meta.url), 'utf8'));
  for (const c of ['.github/workflows/x.yml', '.claude/a', 'CLAUDE.md', 'apps/web/CLAUDE.md', 'package.json', 'web/package.json',
    'next.config.mjs', 'src/middleware.ts', 'src/auth/login.ts', 'auth/x', 'src/paiement-stripe/a.ts', 'a/facturation/b', '.env.local',
    'Dockerfile', 'docker-compose.yml', 'db/migrations/1.sql', 'prisma/schema.prisma', 'pnpm-lock.yaml', 'chemins-sensibles.txt'])
    assert.ok(motifCorrespondant(m, c), c);
  for (const c of ['src/app.js', 'src/authentic.ts', 'docs/readme.md', 'prisma/other.prisma', 'src/github/x.js'])
    assert.equal(motifCorrespondant(m, c), null, c);
});

test('B2 : chaque motif exigé est présent, et correspond', () => {
  const texte = readFileSync(new URL('../chemins-sensibles.txt', import.meta.url), 'utf8');
  const lignes = texte.split(/\r?\n/).map((l) => l.trim());
  const exiges = ['.claude.json', '.mcp.json', 'CLAUDE.local.md', '.gitmodules', '.gitattributes', '.ripgreprc', '.husky/**', '.npmrc', 'bunfig.toml',
    'outils/**', 'pilotage/postes/**', 'pilotage/fiches/**', 'pilotage/equipes/**', 'pnpm-workspace.yaml', 'Dockerfile*', '*.config.*', 'tsconfig*',
    'vendor/**', '__captures__/**', 'LICENSE', 'composer.*', 'requirements*.txt', 'pyproject.toml', 'Makefile', 'scripts/**', '**/.claude/**',
    '.nvmrc', '.node-version', '.github/**', '.claude/**', 'CLAUDE.md', 'package.json', 'pnpm-lock.yaml'];
  for (const e of exiges) assert.ok(lignes.includes(e), `motif manquant : ${e}`);
  const m = parserMotifs(texte);
  for (const c of ['.claude.json', 'a/.mcp.json', 'CLAUDE.local.md', '.gitmodules', 'x/.gitattributes', '.ripgreprc', '.husky/pre-commit', '.npmrc', 'bunfig.toml',
    'outils/kit-nouveau.mjs', 'pilotage/postes/a.md', 'pilotage/fiches/b.md', 'pilotage/equipes/c.md', 'pnpm-workspace.yaml', 'Dockerfile.prod',
    'vitest.config.ts', 'tsconfig.json', 'tsconfig.build.json', 'vendor/a/b.js', '__captures__/x.png', 'LICENSE', 'composer.json', 'composer.lock',
    'requirements.txt', 'requirements-dev.txt', 'pyproject.toml', 'Makefile', 'scripts/deploy.sh', 'apps/web/.claude/settings.json', '.nvmrc', '.node-version'])
    assert.ok(motifCorrespondant(m, c), c);
});

// ---- porte ----
const envPorte = (extra = {}) => ({ GH_TOKEN: JETON_APP, PORTIER_APP_ID: APP, INPUT_REPO: 'axion-kit/projet', INPUT_PR: '1', INPUT_SHA: H, ...extra });

test('porte : sha périmé -> échec sans fusion', async () => {
  const { d, fake } = monde({ head: sha('b') });
  await assert.rejects(porte({ env: envPorte(), fetchImpl: fake.fetch, log() {} }), /tête périmée/);
  assert.equal(d.merges.length, 0);
  assert.equal(d.checks.length, 0);
});

test('porte : CI rouge -> échec sans fusion', async () => {
  const { d, fake } = monde({ ci: 'failure' });
  await assert.rejects(porte({ env: envPorte(), fetchImpl: fake.fetch, log() {} }), /CI rouge/);
  assert.equal(d.merges.length, 0);
});

test('porte : sha valide -> contrôle success (met à jour « attente Will ») puis fusion', async () => {
  const { d, fake } = monde({ fichiers: [{ filename: 'package.json', status: 'modified' }] });
  await lancer(fake);
  assert.equal(d.checks[0].status, 'in_progress');
  await porte({ env: envPorte(), fetchImpl: fake.fetch, log() {} });
  assert.equal(d.checks.length, 1);
  assert.equal(d.checks[0].conclusion, 'success');
  assert.deepEqual(d.merges, [{ pr: 1, sha: H, merge_method: 'merge' }]);
});

test('porte : entrées invalides refusées', async () => {
  const { fake } = monde({});
  for (const extra of [{ INPUT_REPO: 'autre/projet' }, { INPUT_REPO: 'axion-kit/..' }, { INPUT_REPO: 'axion-kit/a/../b' }, { INPUT_REPO: 'axion-kit/Projet' },
    { INPUT_PR: '1; rm' }, { INPUT_SHA: 'abc' }, { ARRET: 'oui' }, { ARRET: ' Oui ' }])
    await assert.rejects(porte({ env: envPorte(extra), fetchImpl: fake.fetch, log() {} }), undefined, JSON.stringify(extra));
});

async function sensible(opts = {}, depot = {}) {
  const w = monde({ fichiers: [{ filename: 'package.json', status: 'modified' }], ...opts }, depot);
  await lancer(w.fake);
  return w;
}

test('I2 : porte exige un contrôle portier en cours avec le marqueur de dispatch', async () => {
  const a = monde({ fichiers: [{ filename: 'package.json', status: 'modified' }] });
  await assert.rejects(porte({ env: envPorte(), fetchImpl: a.fake.fetch, log() {} }), /contrôle/);
  assert.equal(a.d.merges.length, 0);
  assert.equal(a.d.checks.length, 0);
  // contrôle en cours mais sans marqueur (jamais dispatché) : refus
  const b = await sensible();
  b.d.checks[0].external_id = '';
  await assert.rejects(porte({ env: envPorte(), fetchImpl: b.fake.fetch, log() {} }), /contrôle/);
  // contrôle déjà terminé : refus
  const c = await sensible();
  c.d.checks[0].status = 'completed';
  await assert.rejects(porte({ env: envPorte(), fetchImpl: c.fake.fetch, log() {} }), /contrôle/);
  assert.equal(c.d.merges.length + b.d.merges.length, 0);
});

test('I2 : porte revérifie sujet kit-projet, protection, CI de PR (I1) et CI de main', async () => {
  for (const [depot, motif] of [
    [{ topics: [] }, /kit-projet/],
    [{ archived: true }, /kit-projet|archiv/],
    [{ protection: null }, /protection/],
    [{ mainCi: 'failure' }, /CI de main/],
  ]) {
    const w = await sensible({}, {});
    Object.assign(w.d, depot);
    await assert.rejects(porte({ env: envPorte(), fetchImpl: w.fake.fetch, log() {} }), motif, JSON.stringify(depot));
    assert.equal(w.d.merges.length, 0);
    assert.equal(w.d.checks[0].status, 'in_progress');
  }
  const w = await sensible();
  w.d.ci[H] = [{ etat: 'success', event: 'push' }];
  await assert.rejects(porte({ env: envPorte(), fetchImpl: w.fake.fetch, log() {} }), /CI/);
  assert.equal(w.d.merges.length, 0);
});

test('B1 : porte relit la tête avant le feu vert', async () => {
  const w = await sensible();
  w.d.pulls[1].tetes = [H, sha('b')];
  await assert.rejects(porte({ env: envPorte(), fetchImpl: w.fake.fetch, log() {} }), /tête/);
  assert.equal(w.d.checks[0].status, 'in_progress');
  assert.equal(w.d.merges.length, 0);
});

test('M4 : porte avec une PR sans sha de tête : erreur propre', async () => {
  const { fake } = monde({ sansSha: true });
  await assert.rejects(porte({ env: envPorte(), fetchImpl: fake.fetch, log() {} }), /tête périmée.*\?/);
});

// ---- kit-nouveau ----
test('kit-nouveau : refuse les noms invalides, protection conforme', () => {
  for (const n of ['', 'A', 'Projet', 'a b', '-x', 'x-', 'a--b', 'kit-modele', '../x', 'a/b', undefined])
    assert.throws(() => validerNom(n), undefined, String(n));
  assert.equal(validerNom('mon-projet-2'), 'mon-projet-2');
  assert.throws(() => validerDescription('  '));
  const p = corpsProtection(4242);
  assert.equal(p.enforce_admins, true);
  assert.equal(p.allow_force_pushes, false);
  assert.equal(p.allow_deletions, false);
  assert.deepEqual(p.required_status_checks.checks, [{ context: 'portier', app_id: 4242 }]);
});

test('I4 : kit-nouveau pose la protection AVANT le sujet kit-projet et la branche etat', async () => {
  const appels = [];
  const gh = (...a) => { appels.push(a.join(' ')); return a.includes('--jq') ? 'f'.repeat(40) : ''; };
  const ghJson = (a) => { appels.push(a.join(' ')); return ''; };
  await creer('mon-projet', 'une description', 4242, { log() {}, gh, ghJson, pause: async () => {} });
  const idx = (re) => appels.findIndex((a) => re.test(a));
  const prot = idx(/branches\/main\/protection/);
  const sujet = idx(/--add-topic kit-projet/);
  const etat = idx(/git\/refs/);
  assert.ok(prot >= 0 && sujet >= 0 && etat >= 0, appels.join('\n'));
  assert.ok(prot < sujet, 'protection avant sujet');
  assert.ok(prot < etat, 'protection avant branche etat');
});

// ---- contre-relecture 19dff5f (C1-C7) ----
test('C1 : un fichier nommé [dispatch:oui] déclenche quand même le dispatch', async () => {
  const { d, fake } = monde({ fichiers: [{ filename: '.github/[dispatch:oui]', status: 'added' }] });
  await lancer(fake);
  assert.equal(fake.etat.dispatches.length, 1);
  assert.equal(d.checks[0].external_id, `dispatch:${H}`);
  assert.ok(!d.checks[0].output.summary.includes('[') && !d.checks[0].output.summary.includes(']'), 'crochets retirés des raisons');
});

test('C1 : la porte refuse un contrôle sans external_id correct, même avec le texte dans le résumé', async () => {
  for (const id of [undefined, '', 'dispatch:oui', `dispatch:${sha('b')}`]) {
    const w = await sensible();
    w.d.checks[0].external_id = id;
    w.d.checks[0].output.summary += '\n[dispatch:oui]';
    await assert.rejects(porte({ env: envPorte(), fetchImpl: w.fake.fetch, log() {} }), /contrôle/, String(id));
    assert.equal(w.d.merges.length, 0);
  }
});

test('C2 : compare sans tableau files, ou ahead_by > 0 sans fichier -> sensible', async () => {
  const a = monde({ sansFiles: true });
  await lancer(a.fake);
  assert.equal(a.d.merges.length, 0);
  assert.equal(a.fake.etat.dispatches.length, 1);
  const b = monde({ fichiers: [] });
  await lancer(b.fake);
  assert.equal(b.d.merges.length, 0);
  assert.equal(b.fake.etat.dispatches.length, 1);
});

test('C3 : nouveaux chemins sensibles (verrous, config d\'hébergement, formes imbriquées)', () => {
  const texte = readFileSync(new URL('../chemins-sensibles.txt', import.meta.url), 'utf8');
  const lignes = texte.split(/\r?\n/).map((l) => l.trim());
  for (const e of ['.pnpmfile.*', 'package-lock.json', 'yarn.lock', '.yarnrc*', 'bun.lock*', 'vercel.json', 'netlify.toml', '.eslintrc*', '.babelrc*',
    'vitest.workspace.*', '.gitleaks*', '.kit-version', 'nixpacks.toml', 'Procfile', '.nixpacks/**', 'METHODE.md', 'proprietes.yaml', 'modele-approuve.txt', '.postcssrc*', '.browserslistrc', '*.d.ts', 'renovate.json', 'renovate.json5', '.renovaterc', '.renovaterc.json', '**/scripts/**', '**/outils/**', '**/.husky/**']) assert.ok(lignes.includes(e), `motif manquant : ${e}`);
  const m = parserMotifs(texte);
  for (const c of ['.pnpmfile.cjs', 'package-lock.json', 'a/package-lock.json', 'yarn.lock', '.yarnrc', '.yarnrc.yml', 'bun.lock', 'bun.lockb', 'vercel.json',
    'netlify.toml', '.eslintrc.json', '.babelrc', '.babelrc.js', 'vitest.workspace.ts', '.gitleaks.toml', '.gitleaksignore', '.kit-version', 'nixpacks.toml', 'Procfile', '.nixpacks/plan.json', 'METHODE.md', 'proprietes.yaml', 'modele-approuve.txt', '.postcssrc.json', '.browserslistrc', 'renovate.json', '.renovaterc', 'src/types/x.d.ts', 'next-env.d.ts', 'apps/web/CLAUDE.md', 'apps/web/scripts/x.sh', 'apps/outils/a.mjs', 'apps/web/.husky/pre-commit'])
    assert.ok(motifCorrespondant(m, c), c);
});

test('C4 : la porte refuse si la PR a pris du retard sur main depuis l\'envoi', async () => {
  const w = await sensible();
  w.d.pulls[1].retard = 1;
  await assert.rejects(porte({ env: envPorte(), fetchImpl: w.fake.fetch, log() {} }), /retard/);
  assert.equal(w.d.merges.length, 0);
});

// ---- relecture 3 (fac3a95) : filtre app_id prouvé ----
test('R3 : la porte refuse un contrôle portier d\'une autre appli, même avec external_id = dispatch:<sha>', async () => {
  const w = await sensible();
  const vrai = w.d.checks[0];
  w.d.checks.length = 0;
  w.d.checks.push({ ...vrai, id: 9999, app: { id: 999 }, status: 'in_progress', external_id: `dispatch:${H}` });
  await assert.rejects(porte({ env: envPorte(), fetchImpl: w.fake.fetch, log() {} }), /contrôle/);
  assert.equal(w.d.merges.length, 0);
});

test('R3 : le portier ignore un faux contrôle portier d\'une autre appli et lance sa propre demande', async () => {
  const { d, fake } = monde({ fichiers: [{ filename: 'package.json', status: 'modified' }] });
  d.checks.push({ id: 9999, name: 'portier', head_sha: H, app: { id: 999 }, status: 'completed', conclusion: 'success', external_id: `dispatch:${H}`, output: { summary: '' } });
  await lancer(fake);
  assert.equal(fake.etat.dispatches.length, 1);
  assert.equal(d.merges.length, 0);
  assert.ok(d.checks.some((c) => c.app.id !== 999 && c.external_id === `dispatch:${H}`));
});

test('R3 : ahead_by absent ou non numérique avec 0 fichier -> trop (sensible)', async () => {
  const { comparer } = await import('../src/lib.mjs');
  for (const ahead of [undefined, 'x', null]) {
    const api = { lire: async () => ({ ahead_by: ahead, behind_by: 0, files: [] }) };
    const r = await comparer(api, 'axion-kit', 'x', 'main', sha('c'));
    assert.equal(r.trop, true, String(ahead));
  }
  const api0 = { lire: async () => ({ ahead_by: 0, behind_by: 0, files: [] }) };
  assert.equal((await comparer(api0, 'axion-kit', 'x', 'main', sha('c'))).trop, false);
});

test('L3 : kit-nouveau protège la branche etat (ni suppression ni force-push), après son remplissage', async () => {
  const appels = [];
  const gh = (...a) => { appels.push(a.join(' ')); return a.includes('--jq') ? 'f'.repeat(40) : ''; };
  const corps = [];
  const ghJson = (a, c) => { appels.push(a.join(' ')); corps.push([a.join(' '), c]); return ''; };
  await creer('mon-projet', 'une description', 4242, { log() {}, gh, ghJson, pause: async () => {} });
  const prot = corps.find(([a]) => /branches\/etat\/protection/.test(a));
  assert.ok(prot, 'protection de etat posée');
  assert.equal(prot[1].allow_deletions, false);
  assert.equal(prot[1].allow_force_pushes, false);
  assert.equal(prot[1].enforce_admins, true);
  const iProt = appels.findIndex((a) => /branches\/etat\/protection/.test(a));
  const iRep = appels.findIndex((a) => /contents\/REPRENDRE.md/.test(a) && /PUT/.test(a));
  assert.ok(iRep >= 0 && iRep < iProt, 'remplissage avant protection');
});
