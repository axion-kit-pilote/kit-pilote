import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { creerClient } from '../src/coolify.mjs';
import { synchroniserEssai, verifierEssai, liberer, choisirOutil, resumeChangements, sonde } from '../src/production.mjs';
import { fauxCoolify, SHA_A, SHA_B, SHA_C, JETON, URL_C } from './l7-faux-coolify.mjs';

const OUTIL = {
  nom: 'demo', depot: 'axion-kit/demo',
  essai: { uuid: 'ess1', sonde: 'https://essai.demo.test/sante' },
  production: { uuid: 'prd1', sonde: 'https://demo.test/sante', db_uuid: 'db1' },
};
const SANS_BASE = { ...OUTIL, production: { uuid: 'prd1', sonde: 'https://demo.test/sante' } };
const sleep = async () => {};
const mk = (opts) => {
  const faux = fauxCoolify(opts);
  return { faux, client: creerClient({ url: URL_C, jeton: JETON, fetch: faux.f, sleep }), f: faux.f };
};
const journalDe = () => { const l = []; return { l, journal: (x) => l.push(x) }; };

test('essai : déploie exactement le SHA demandé', async () => {
  const { faux, client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
  const r = await synchroniserEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep });
  assert.equal(r.ok, true);
  assert.equal(faux.apps.ess1.git_commit_sha, SHA_B);
  const patch = faux.appels.find((a) => a.methode === 'PATCH');
  assert.equal(patch.corps.git_commit_sha, SHA_B);
});

test('essai : déjà à jour = aucun déploiement', async () => {
  const { faux, client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_B, status: 'running:healthy' } } });
  const r = await synchroniserEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep });
  assert.equal(r.change, false);
  assert.ok(!faux.appels.some((a) => a.chemin?.startsWith('/api/v1/deploy?')));
});

test('libération refusée si le SHA n\'est pas sur l\'essai', async () => {
  const { client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
  const v = await verifierEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep });
  assert.deepEqual(v, { ok: false, code: 'SHA_NON_DEPLOYE_SUR_ESSAI' });
});

test('libération refusée si l\'essai est en mauvaise santé', async () => {
  const { client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_B, status: 'running:healthy' } }, sante: () => false });
  assert.equal((await verifierEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep })).code, 'ESSAI_SANTE_KO');
});

test('libération acceptée si le SHA est sain sur l\'essai', async () => {
  const { client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_B, status: 'running:healthy' } } });
  assert.equal((await verifierEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep })).ok, true);
});

test('production : sauvegarde à la demande réussie PUIS déploiement du bon SHA', async () => {
  const { faux, client, f } = mk({ bases: { db1: { sauvegarde: 'success' } }, apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy', envs: [{ key: 'X', value: 'v' }] } } });
  const { l, journal } = journalDe();
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep, journal });
  assert.equal(r.ok, true);
  assert.equal(faux.bases.db1.declenchee, 1);
  assert.equal(faux.apps.prd1.git_commit_sha, SHA_B);
  assert.ok(l.indexOf('SAUVEGARDE_BASE_OK') < l.indexOf('PROD_OK'));
});

for (const sauvegarde of ['failed', 'jamais', 'absente']) {
  test(`sauvegarde ${sauvegarde} : SAUVEGARDE_KO, rien n'est déployé`, async () => {
    const { faux, client, f } = mk({ bases: { db1: { sauvegarde } }, apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
    const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep });
    assert.equal(r.code, 'SAUVEGARDE_KO');
    assert.equal(faux.apps.prd1.git_commit_sha, SHA_A);
    assert.ok(!faux.appels.some((a) => a.chemin?.startsWith('/api/v1/deploy?')));
  });
}

test('sans db_uuid : on le dit (journal et résultat), le déploiement a lieu', async () => {
  const { client, f } = mk({ apps: { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } } });
  const { l, journal } = journalDe();
  const r = await liberer({ client, f, outil: SANS_BASE, sha: SHA_B, sleep, journal });
  assert.equal(r.ok, true);
  assert.equal(r.sansBase, true);
  assert.ok(l.includes('SAUVEGARDE_BASE_AUCUNE'));
  assert.match(resumeChangements({ outil: 'demo', sha: SHA_B, filiation: true, baseDeclaree: false }), /pas de base de données déclarée/);
  assert.match(resumeChangements({ outil: 'demo', sha: SHA_B, filiation: true, baseDeclaree: true }), /sauvegarde à la demande/);
});

// --- P1 : « vérifiée sur l'essai » = dernier déploiement RÉUSSI + sonde qui annonce le SHA ---
test('P1 : déploiement d\'essai en échec (SHA patché, ancien conteneur) -> verifierEssai refuse', async () => {
  const { faux, client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_A, status: 'running:healthy' } }, deploiementEchoue: (sha) => sha === SHA_B });
  const r = await synchroniserEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep });
  assert.equal(r.ok, false);
  assert.equal(faux.apps.ess1.git_commit_sha, SHA_B); // le SHA est patché…
  assert.equal(faux.apps.ess1.sert, SHA_A); // …mais l'ancien conteneur tourne encore
  assert.deepEqual(await verifierEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep }), { ok: false, code: 'SHA_NON_DEPLOYE_SUR_ESSAI' });
});

test('P1 : sonde 200 mais qui annonce un autre SHA (ancien conteneur) -> refus', async () => {
  const { client, f } = mk({ apps: { ess1: { git_commit_sha: SHA_B, status: 'running:healthy', sert: SHA_A, deploiements: [{ status: 'finished', commit: SHA_B, created_at: 5 }] } } });
  assert.equal((await verifierEssai({ client, f, outil: OUTIL, sha: SHA_B, sleep })).code, 'ESSAI_SANTE_KO');
});

test('P1 : sonde sans SHA dans la réponse -> refus', async () => {
  const f = async (u) => ({ ok: true, status: 200, text: async () => 'OK' });
  assert.equal(await sonde(f, 'https://x.test/sante', SHA_B, { essais: 1 }), false);
  const g = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ sha: SHA_B }) });
  assert.equal(await sonde(g, 'https://x.test/sante', SHA_B, { essais: 1 }), true);
  assert.equal(await sonde(g, 'http://x.test/sante', SHA_B, { essais: 1 }), false);
});

test('P1 : le dernier déploiement terminé compte, pas un plus récent en échec', async () => {
  const deploiements = [
    { status: 'finished', commit: SHA_A, created_at: 1 },
    { status: 'failed', commit: SHA_B, created_at: 9 },
    { status: 'in_progress', commit: SHA_C, created_at: 10 },
  ];
  const { client } = mk({ apps: { ess1: { git_commit_sha: SHA_C, status: 'running:healthy', sert: SHA_A, deploiements } } });
  assert.equal((await client.dernierDeploiementReussi('ess1')).commit, SHA_A);
});

test('P1 : production déjà à jour seulement si dernier déploiement réussi ET sonde (PROD_DEJA_A_JOUR)', async () => {
  // SHA patché mais déploiement en échec : pas « à jour » -> on déploie
  const apps = { prd1: { git_commit_sha: SHA_B, status: 'running:healthy', sert: SHA_A, deploiements: [{ status: 'finished', commit: SHA_A, created_at: 1 }, { status: 'failed', commit: SHA_B, created_at: 2 }] } };
  const { l, journal } = journalDe();
  const { client, f, faux } = mk({ apps, bases: { db1: { sauvegarde: 'success' } } });
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep, journal });
  assert.equal(r.ok, true);
  assert.ok(!l.includes('PROD_DEJA_A_JOUR'));
  assert.equal(faux.apps.prd1.sert, SHA_B);
  // vraiment à jour : rien n'est créé (ni sauvegarde, ni PATCH, ni déploiement)
  const n = faux.appels.length;
  const r2 = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep });
  assert.equal(r2.code, 'PROD_DEJA_A_JOUR');
  assert.ok(!faux.appels.slice(n).some((a) => a.methode !== 'GET' || a.chemin?.startsWith('/api/v1/deploy?')));
});

test('P1 : le retour arrière vise la version qui tournait vraiment, pas le SHA patché', async () => {
  const apps = { prd1: { git_commit_sha: SHA_C, status: 'running:healthy', sert: SHA_A, deploiements: [{ status: 'finished', commit: SHA_A, created_at: 1 }, { status: 'failed', commit: SHA_C, created_at: 2 }] } };
  const { client, f } = mk({ apps, bases: { db1: { sauvegarde: 'success' } }, deploiementEchoue: (sha) => sha === SHA_B });
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep });
  assert.equal(r.precedent, SHA_A);
  assert.equal(r.retourArriereOk, true);
  assert.equal(apps.prd1.sert, SHA_A);
});

test('mineur : retour arrière refusé si l\'avant n\'est pas un SHA hexadécimal', async () => {
  const apps = { prd1: { git_commit_sha: 'HEAD', status: 'running:healthy', sert: 'x', deploiements: [{ status: 'finished', commit: 'HEAD', created_at: 1 }] } };
  const { client, f } = mk({ apps, bases: { db1: { sauvegarde: 'success' } }, deploiementEchoue: () => true });
  const { l, journal } = journalDe();
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep, journal });
  assert.equal(r.retourArriere, false);
  assert.ok(l.includes('RETOUR_ARRIERE_IMPOSSIBLE'));
});

test('image par empreinte : chemin préparé, entrées validées', async () => {
  const { faux, client } = mk({ apps: { x1: {} } });
  await client.fixerImage('x1', 'ghcr.io/axion-kit/demo', 'sha256:' + 'a'.repeat(64));
  assert.deepEqual(faux.appels.at(-1).corps, { docker_registry_image_name: 'ghcr.io/axion-kit/demo', docker_registry_image_tag: 'sha256:' + 'a'.repeat(64) });
  await assert.rejects(client.fixerImage('x1', 'ghcr.io/x', 'latest'));
  await assert.rejects(client.fixerImage('x1', 'Image Piégée;', 'sha256:' + 'a'.repeat(64)));
});

test('retour arrière automatique si la sonde de santé échoue', async () => {
  // la sonde est KO tant que la production est sur SHA_B ; OK sur SHA_A
  const apps = { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } };
  const { client, f } = mk({ apps, bases: { db1: { sauvegarde: 'success' } }, sante: (u, a) => a.prd1.git_commit_sha !== SHA_B });
  const { l, journal } = journalDe();
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep, journal });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'SANTE_KO');
  assert.equal(r.retourArriere, true);
  assert.equal(r.retourArriereOk, true);
  assert.equal(apps.prd1.git_commit_sha, SHA_A);
  assert.ok(l.includes('RETOUR_ARRIERE_OK'));
});

test('retour arrière aussi si le déploiement lui-même échoue', async () => {
  const apps = { prd1: { git_commit_sha: SHA_A, status: 'running:healthy' } };
  const { client, f } = mk({ apps, bases: { db1: { sauvegarde: 'success' } }, deploiementEchoue: (sha) => sha === SHA_C });
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_C, sleep });
  assert.equal(r.code, 'DEPLOIEMENT_KO');
  assert.equal(r.retourArriereOk, true);
  assert.equal(apps.prd1.git_commit_sha, SHA_A);
});

test('première mise en production sans version précédente : échec signalé, pas de retour arrière', async () => {
  const { client, f } = mk({ apps: { prd1: { git_commit_sha: null, status: 'exited' } }, sante: () => false });
  // (outil sans base : OUTIL_SB)
  const r = await liberer({ client, f, outil: SANS_BASE, sha: SHA_B, sleep });
  assert.equal(r.ok, false);
  assert.equal(r.retourArriere, false);
});

test('le jeton n\'apparaît dans aucun journal ni résultat', async () => {
  const apps = { prd1: { git_commit_sha: SHA_A, status: 'running:healthy', envs: [{ key: 'MOT_DE_PASSE', value: 'valeur-tres-secrete' }] } };
  const { client, f } = mk({ apps, bases: { db1: { sauvegarde: 'success' } }, sante: () => false });
  const { l, journal } = journalDe();
  const r = await liberer({ client, f, outil: OUTIL, sha: SHA_B, sleep, journal });
  const tout = JSON.stringify([l, r]);
  for (const s of [JETON, URL_C, 'valeur-tres-secrete']) assert.ok(!tout.includes(s));
});

test('choisirOutil refuse un nom inconnu ou piégé', () => {
  const cfg = { outils: { demo: {} } };
  assert.throws(() => choisirOutil(cfg, 'autre'));
  assert.throws(() => choisirOutil(cfg, '__proto__'));
  assert.throws(() => choisirOutil(cfg, 'constructor'));
  assert.throws(() => choisirOutil(cfg, 'toString'));
  assert.throws(() => choisirOutil({ outils: Object.create({ heritee: {} }) }, 'heritee'));
  assert.equal(choisirOutil(cfg, 'demo').nom, 'demo');
});

test('résumé avant approbation', () => {
  const t = resumeChangements({ outil: 'demo', sha: SHA_B, commits: [{ sha: SHA_C, message: 'Ajoute x\ndétail' }], filiation: true });
  assert.match(t, /Changements \(1\)/);
  assert.match(t, /Ajoute x/);
  assert.ok(!t.includes('détail'));
});

test('P7 : un message de commit hostile reste inerte dans le résumé', () => {
  const hostile = 'Corrige`\n\n## Approuver sans lire ![x](https://evil.test/a.png) [clic](https://evil.test) <img src=x> \u202e\u200b`';
  const t = resumeChangements({ outil: 'demo', sha: SHA_B, commits: [{ sha: SHA_C, message: hostile }], filiation: true });
  assert.ok(!t.includes('## Approuver'));
  const ligne = t.split('\n').find((x) => x.includes('message de commit'));
  assert.ok(ligne.includes('`message de commit : Corrige'));
  // un seul bloc inline : exactement 4 backticks sur la ligne (sha + message), aucun fourni par le message
  assert.equal((ligne.match(/`/g) ?? []).length, 4);
  assert.ok(!/[\u202e\u200b]/.test(t));
  assert.ok(!t.includes('\n\n## '));
});

// --- Contrôles des workflows ---
const dir = new URL('../.github/workflows/', import.meta.url);
for (const nom of ['essai.yml', 'liberer.yml']) {
  const y = readFileSync(new URL(nom, dir), 'utf8');
  test(`${nom} : actions épinglées, pas de pull_request_target, aucun input dans run:`, () => {
    for (const m of y.matchAll(/uses:\s*(\S+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
    assert.ok(!y.includes('pull_request'));
    // Ligne `run:` (et blocs multi-lignes) sans expression ${{ }}.
    const lignes = y.split('\n');
    lignes.forEach((ligne, i) => {
      if (/^\s*run:/.test(ligne)) {
        let bloc = ligne;
        if (/run:\s*[|>]/.test(ligne)) {
          const ind = ligne.match(/^\s*/)[0].length;
          for (let j = i + 1; j < lignes.length && (lignes[j].trim() === '' || lignes[j].match(/^\s*/)[0].length > ind); j++) bloc += lignes[j];
        }
        assert.ok(!bloc.includes('${{'), bloc);
      }
    });
    assert.match(y, /permissions:\n\s+contents: read/);
  });
}

test('liberer.yml : environnement production, run-name lisible, essai séparé', () => {
  const y = readFileSync(new URL('liberer.yml', dir), 'utf8');
  assert.match(y, /run-name: .*inputs\.outil.*inputs\.sha/);
  assert.match(y, /environment: production/);
  assert.match(y, /needs: verifier/);
  assert.match(y, /COOLIFY_JETON_PRODUCTION/);
  assert.ok(!/COOLIFY_JETON_ESSAI[\s\S]*environment: production[\s\S]*COOLIFY_JETON_ESSAI/.test(y));
});

test('essai.yml : environnement essai, secrets attendus, cron et dispatch', () => {
  const y = readFileSync(new URL('essai.yml', dir), 'utf8');
  assert.match(y, /environment: essai/);
  assert.match(y, /COOLIFY_URL_ESSAI/);
  assert.match(y, /COOLIFY_JETON_ESSAI/);
  assert.match(y, /workflow_dispatch/);
  assert.match(y, /schedule:/);
});
