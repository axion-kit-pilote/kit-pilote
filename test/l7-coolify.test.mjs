import test from 'node:test';
import assert from 'node:assert/strict';
import { creerClient, CoolifyError } from '../src/coolify.mjs';
import { fauxCoolify, SHA_A, SHA_B, JETON, URL_C } from './l7-faux-coolify.mjs';

const nouveau = (opts = {}) => {
  const faux = fauxCoolify(opts);
  return { faux, c: creerClient({ url: URL_C, jeton: JETON, fetch: faux.f, sleep: async () => {} }) };
};

test('création depuis un dépôt public et un SHA précis', async () => {
  const { faux, c } = nouveau();
  const uuid = await c.creerApplication({ projet: 'p1', serveur: 's1', depot: 'axion-kit/outil', sha: SHA_A, nom: 'outil-essai' });
  assert.equal(uuid, 'nouvelle');
  const a = faux.appels[0];
  assert.equal(a.corps.git_repository, 'https://github.com/axion-kit/outil');
  assert.equal(a.corps.git_commit_sha, SHA_A);
  assert.equal(a.auth, `Bearer ${JETON}`);
});

test('SHA invalide ou identifiant piégé refusés avant tout appel', async () => {
  const { faux, c } = nouveau({ apps: { x1: {} } });
  await assert.rejects(c.fixerSha('x1', 'main'), CoolifyError);
  await assert.rejects(c.lireApplication('../../etc'), CoolifyError);
  assert.equal(faux.appels.length, 0);
});

test('déployer, lire l\'état, variables (création puis mise à jour)', async () => {
  const { faux, c } = nouveau({ apps: { x1: { git_commit_sha: SHA_A, status: 'exited' } } });
  await c.fixerSha('x1', SHA_B);
  const id = await c.deployer('x1');
  assert.equal(await c.attendreDeploiement(id), true);
  assert.deepEqual({ ...(await c.lireApplication('x1')), brut: 0 }, { sha: SHA_B, statut: 'running:healthy', brut: 0 });
  await c.poserVariable('x1', 'MODE', 'a');
  await c.poserVariable('x1', 'MODE', 'b');
  assert.equal(faux.apps.x1.envs.length, 1);
  assert.equal(faux.apps.x1.envs[0].value, 'b');
  await assert.rejects(c.poserVariable('x1', 'mauvais nom', '1'), CoolifyError);
});

test('https obligatoire, jeton obligatoire', () => {
  assert.throws(() => creerClient({ url: 'http://coolify.exemple.test', jeton: JETON }), CoolifyError);
  assert.throws(() => creerClient({ url: URL_C, jeton: '' }), CoolifyError);
});

test('le jeton et l\'URL ne sortent jamais dans une erreur', async () => {
  const { c } = nouveau({ apps: { x1: {} }, fuiteJeton: true });
  await assert.rejects(c.lireApplication('x1'), (e) => {
    const t = e.message + e.stack;
    assert.ok(!t.includes(JETON) && !t.includes(URL_C), t);
    return e.statut === 500;
  });
  const mauvais = creerClient({ url: URL_C, jeton: 'autre-jeton-0000', fetch: fauxCoolify().f });
  await assert.rejects(mauvais.lireApplication('x1'), (e) => !e.message.includes('autre-jeton-0000') && e.statut === 401);
});

test('erreur réseau : jeton masqué', async () => {
  const c = creerClient({ url: URL_C, jeton: JETON, fetch: async () => { throw new Error(`échec avec ${JETON}`); } });
  await assert.rejects(c.lireApplication('x1'), (e) => !e.message.includes(JETON));
});
