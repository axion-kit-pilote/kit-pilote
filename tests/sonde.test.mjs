import test from 'node:test';
import assert from 'node:assert/strict';
import { sonde } from '../src/sonde.mjs';
import { creerApi } from '../src/client6.mjs';
import { creerFake, depot, envSonde, J_ARRET, J_PILOTE } from './fake6.mjs';
import { INSTALLATIONS_ATTENDUES } from '../src/sonde.mjs';

const lancer = (fake, env = {}, maintenant = Date.now()) =>
  sonde({ env: envSonde(env), fetchImpl: fake.fetch, maintenant, log: () => {} });
const alertes = (f) => f.etat.issues.filter((i) => i.title.startsWith('ALERTE'));
const memoire = (f) => ({ body: f.etat.variables.SONDE_MEMOIRE });   // mémoire = variable Actions, plus une issue publique

test('tout est conforme : aucune alerte, pas d\'ARRET, mémoire écrite', async () => {
  const f = creerFake({ depots: [depot('a'), depot('b')] });
  const r = await lancer(f);
  assert.equal(r.graves, 0);
  assert.equal(alertes(f).length, 0);
  assert.equal('ARRET' in f.etat.variables, false);
  assert.deepEqual(JSON.parse(memoire(f).body).ids.length, 2);
});

for (const [nom, change, mot] of [
  ['aucune protection', (d) => { d.protection = null; }, /aucune protection/],
  ['enforce_admins absent', (d) => { d.protection.enforce_admins.enabled = false; }, /enforce_admins/],
  ['force-push permis', (d) => { d.protection.allow_force_pushes.enabled = true; }, /force-push/],
  ['suppression permise', (d) => { d.protection.allow_deletions.enabled = true; }, /suppression/],
  ['contrôle portier sans app_id', (d) => { d.protection.required_status_checks.checks[0].app_id = -1; }, /limité/],
  ['contrôle portier d\'une autre appli', (d) => { d.protection.required_status_checks.checks.push({ context: 'portier', app_id: 7 }); }, /autre application/],
  ['aucun contrôle', (d) => { d.protection.required_status_checks.checks = []; }, /limité/],
  ['ruleset avec contournement', (d) => { d.rules = [{ ruleset_source_type: 'Repository', ruleset_id: 5 }]; d.rulesets[5] = { bypass_actors: [{ actor_id: 1 }] }; }, /contournements/],
  ['ruleset du dépôt non listé par les règles de main, avec bypass', (d) => { d.rulesets[6] = { bypass_actors: [{ actor_id: 1 }] }; }, /contournements/],
  ['ruleset illisible', (d) => { d.rules = [{ ruleset_source_type: 'Repository', ruleset_id: 9 }]; }, /illisible/],
]) {
  test(`dérive : ${nom} -> alerte et ARRET=oui`, async () => {
    const d = depot('a'); change(d);
    const f = creerFake({ depots: [d] });
    const r = await lancer(f);
    assert.equal(r.graves, 1);
    assert.equal(alertes(f).length, 1);
    assert.match(alertes(f)[0].body, mot);
    assert.equal(f.etat.variables.ARRET, 'oui');
  });
}

test('un dépôt sans le sujet kit-projet ou archivé est ignoré', async () => {
  const x = depot('x', { topics: [], protection: null });
  const y = depot('y', { archived: true, protection: null });
  const f = creerFake({ depots: [x, y, depot('a')] });
  assert.equal((await lancer(f)).graves, 0);
});

test('alerte non dupliquée au second passage ; ARRET déjà oui non réécrit', async () => {
  const d = depot('a'); d.protection.enforce_admins.enabled = false;
  const f = creerFake({ depots: [d] });
  await lancer(f);
  const r = await lancer(f, { ARRET: 'oui' });
  assert.equal(alertes(f).length, 1);
  assert.equal(r.arret, 'déjà posé');
});

test('installation inattendue sur axion-kit -> grave', async () => {
  const f = creerFake({ depots: [depot('a')], installationsOrg: ['claude', 'kit-portier', 'intrus'] });
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.match(alertes(f)[0].body, /intrus/);
  assert.equal(f.etat.variables.ARRET, 'oui');
});

test('installation attendue manquante -> alerte non grave, pas d\'ARRET', async () => {
  const f = creerFake({ depots: [depot('a')], installationsOrg: ['claude'] });
  const r = await lancer(f);
  assert.equal(r.graves, 0);
  assert.equal(alertes(f).length, 1);
  assert.equal('ARRET' in f.etat.variables, false);
});

test('axion-kit-pilote avec une installation -> grave', async () => {
  const f = creerFake({ depots: [depot('a')], installationsPilote: ['claude'] });
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.match(alertes(f)[0].title, /axion-kit-pilote/);
  assert.equal(f.etat.variables.ARRET, 'oui');
});

test('un dépôt disparaît -> grave ; un dépôt de plus -> mémoire mise à jour', async () => {
  const f = creerFake({ depots: [depot('a'), depot('b'), depot('c')] });
  await lancer(f);
  delete f.etat.depots.c;
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.match(alertes(f)[0].body, /avant : 3, maintenant : 2/);
  assert.equal(JSON.parse(memoire(f).body).ids.length, 2);
  f.etat.depots.z = depot('z'); f.etat.depots.y = depot('y');
  assert.equal((await lancer(f)).graves, 0);
  assert.equal(JSON.parse(memoire(f).body).ids.length, 4);
});

test('S2 : suppression + création dans la même heure -> grave (le nombre ne baisse pas)', async () => {
  const f = creerFake({ depots: [depot('a'), depot('b'), depot('c')] });
  await lancer(f);
  delete f.etat.depots.c;
  f.etat.depots.d = depot('d');           // même nombre, autre id
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.match(alertes(f)[0].title, /a disparu/);
  assert.equal(f.etat.variables.ARRET, 'oui');
});

test('S2 : mémoire trop grosse -> nombre + condensé ; suppression + création toujours détectées', async () => {
  const f = creerFake({ depots: Array.from({ length: 4900 }, (_, i) => depot(`d${i}`, { id: 100000000000 + i })) });
  await lancer(f);
  assert.ok(!('ids' in JSON.parse(memoire(f).body)));
  assert.equal(JSON.parse(memoire(f).body).n, 4900);
  assert.equal((await lancer(f)).graves, 0);
  delete f.etat.depots.d5; f.etat.depots.nouveau = depot('nouveau');
  assert.equal((await lancer(f)).graves, 1);
});

test('S2 : ancienne mémoire « nb_depots=N » reprise ; baisse = grave', async () => {
  const f = creerFake({ depots: [depot('a')], variables: { SONDE_MEMOIRE: 'nb_depots=5\n' } });
  assert.equal((await lancer(f)).graves, 1);
});

test('S1 : kit-createur est une installation attendue', async () => {
  assert.ok(INSTALLATIONS_ATTENDUES.includes('kit-createur'));
  const f = creerFake({ depots: [depot('a')], installationsOrg: ['claude', 'kit-portier', 'kit-createur'] });
  assert.equal((await lancer(f)).graves, 0);
  const g = creerFake({ depots: [depot('a')], installationsOrg: ['claude', 'kit-portier'] });
  await lancer(g);
  assert.match(alertes(g)[0].body, /kit-createur/);
});

test('S6 : rulesets lus par l\'endpoint du dépôt avec includes_parents=true ; ruleset d\'organisation avec bypass -> grave', async () => {
  const d = depot('a'); d.rules = [{ ruleset_source_type: 'Organization', ruleset_id: 8 }];
  const f = creerFake({ depots: [d] });
  f.etat.rulesetsOrg = { 8: { bypass_actors: [{ actor_id: 1 }] } };
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.ok(f.etat.urls.includes('GET /repos/axion-kit/a/rulesets/8?includes_parents=true'));
  assert.ok(!f.etat.appels.some((x) => x.startsWith('GET /orgs/axion-kit/rulesets')));
});

test('S6 : bypass_actors absent -> avertissement, pas « aucun contournement »', async () => {
  const d = depot('a'); d.rules = [{ ruleset_source_type: 'Repository', ruleset_id: 5 }]; d.rulesets[5] = { name: 'x' };
  const f = creerFake({ depots: [d] });
  const r = await lancer(f);
  assert.equal(r.graves, 0);
  assert.equal(r.avertissements.length, 1);
  assert.match(r.avertissements[0], /contournements non fournie/);
  const ok = depot('b'); ok.rules = [{ ruleset_source_type: 'Repository', ruleset_id: 5 }]; ok.rulesets[5] = { bypass_actors: [] };
  assert.equal((await lancer(creerFake({ depots: [ok] }))).avertissements.length, 0);
});

test('S7 : kit-modele est contrôlé même sans le sujet kit-projet', async () => {
  const m = depot('kit-modele', { topics: [] }); m.protection.allow_force_pushes.enabled = true;
  const f = creerFake({ depots: [m] });
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.match(alertes(f)[0].title, /kit-modele/);
});

for (const [nom, etat, mot] of [
  ['aucune protection', { protection: null }, /force-push/],
  ['force-push permis', { protection: { allow_force_pushes: { enabled: true }, allow_deletions: { enabled: false } } }, /force-push/],
  ['suppression permise', { protection: { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: true } } }, /suppression/],
]) {
  test(`S7 : branche etat, ${nom} -> grave`, async () => {
    const d = depot('a', { etat });
    const f = creerFake({ depots: [d] });
    const r = await lancer(f);
    assert.equal(r.graves, 1);
    assert.match(alertes(f)[0].body, mot);
  });
}

test('S7 : branche etat protégée (protection ou règles) ou absente -> conforme', async () => {
  const p = { allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false } };
  const f = creerFake({ depots: [depot('a', { etat: { protection: p } }), depot('b', { etat: { protection: null, rules: [{ type: 'non_fast_forward' }, { type: 'deletion' }] } }), depot('c')] });
  assert.equal((await lancer(f)).graves, 0);
});

test('ORG_TOKEN absent -> alerte grave', async () => {
  const f = creerFake({ depots: [depot('a')] });
  const r = await lancer(f, { ORG_TOKEN: '' });
  assert.equal(r.graves, 1);
  assert.match(alertes(f)[0].title, /ORG_TOKEN/);
});

test('ARRET_TOKEN absent -> alerte grave', async () => {
  const f = creerFake({ depots: [depot('a')] });
  const r = await lancer(f, { ARRET_TOKEN: '' });
  assert.equal(r.graves, 1);
  assert.ok(alertes(f).some((i) => /ARRET_TOKEN/.test(i.title)));
});

test('battement mensuel : vivant.txt absent ou de plus de 40 jours -> alerte non grave', async () => {
  const maintenant = Date.parse('2026-11-07T12:00:00Z');
  let f = creerFake({ depots: [depot('a')], vivant: 'vivant : 2026-09-01T00:00:00.000Z\n' });
  let r = await lancer(f, {}, maintenant);
  assert.equal(r.graves, 0);
  assert.match(alertes(f)[0].title, /battement mensuel/);
  f = creerFake({ depots: [depot('a')], vivant: null });
  await lancer(f, {}, maintenant);
  assert.equal(alertes(f).length, 1);
  f = creerFake({ depots: [depot('a')], vivant: 'vivant : 2026-10-20T00:00:00.000Z\n' });
  await lancer(f, {}, maintenant);
  assert.equal(alertes(f).length, 0);
});

test('une « mémoire » forgée par un autre auteur est ignorée', async () => {
  const faux = { number: 1, state: 'open', title: 'Sonde : mémoire du nombre de dépôts (ne pas fermer)', body: 'nb_depots=999', user: { login: 'intrus' } };
  const f = creerFake({ depots: [depot('a')], issues: [faux] });
  assert.equal((await lancer(f)).graves, 0);
});

test('portier : dernier cycle de plus de 60 min -> alerte non grave ; absent -> alerte', async () => {
  const maintenant = Date.parse('2026-11-07T12:00:00Z');
  let f = creerFake({ depots: [depot('a')], runsPortier: [{ created_at: '2026-11-07T10:50:00Z' }] });
  let r = await lancer(f, {}, maintenant);
  assert.equal(r.graves, 0);
  assert.match(alertes(f)[0].title, /portier ne tourne plus/);
  f = creerFake({ depots: [depot('a')], runsPortier: [{ created_at: '2026-11-07T11:10:00Z' }] });
  await lancer(f, {}, maintenant);
  assert.equal(alertes(f).length, 0);
  f = creerFake({ depots: [depot('a')], runsPortier: [] });
  await lancer(f, {}, maintenant);
  assert.equal(alertes(f).length, 1);
});

test('ARRET impossible à écrire -> alerte avec la commande, résultat « échec »', async () => {
  const d = depot('a'); d.protection = null;
  const f = creerFake({ depots: [d] });
  f.etat.sansDroitVariables = true;
  const r = await lancer(f, { ARRET_TOKEN: J_PILOTE });
  assert.equal(r.arret, 'échec');
  assert.ok(alertes(f).some((i) => i.body.includes('gh variable set ARRET --body oui -R axion-kit-pilote/kit-pilote')));
});

test('ARRET_TOKEN sert à écrire la variable quand le jeton du pilote ne le peut pas', async () => {
  const d = depot('a'); d.protection = null;
  const f = creerFake({ depots: [d] });
  f.etat.sansDroitVariables = true;
  const r = await lancer(f, { ARRET_TOKEN: J_ARRET });
  assert.equal(r.arret, 'posé');
  assert.equal(f.etat.variables.ARRET, 'oui');
});

test('contrôle impossible (403) -> avertissement, pas d\'ARRET', async () => {
  const f = creerFake({ depots: [depot('a')] });
  f.etat.refus.add('/orgs/axion-kit/installations');
  const r = await lancer(f);
  assert.equal(r.graves, 0);
  assert.equal(r.avertissements.length, 1);
  assert.match(alertes(f)[0].title, /impossibles/);
  assert.equal('ARRET' in f.etat.variables, false);
});

test('le jeton de l\'application n\'est jamais utilisé pour écrire dans le pilote', async () => {
  const d = depot('a'); d.protection = null;
  const f = creerFake({ depots: [d] });
  await lancer(f);
  assert.ok(f.etat.appels.every((a) => !/^(POST|PATCH|PUT|DELETE) \/repos\/axion-kit\//.test(a)));
});

test('N3 : la mémoire vit dans la variable SONDE_MEMOIRE, écrite avec ARRET_TOKEN, jamais dans une issue', async () => {
  const f = creerFake({ depots: [depot('a'), depot('b')] });
  await lancer(f);
  assert.deepEqual(JSON.parse(f.etat.variables.SONDE_MEMOIRE).ids.length, 2);
  assert.ok(f.etat.ecrituresVariables.every((x) => x.nom === 'SONDE_MEMOIRE' && x.jeton === J_ARRET));
  assert.equal(f.etat.issues.length, 0, 'aucune issue publique de mémoire');
  const n = f.etat.ecrituresVariables.length;
  await lancer(f);                                   // inchangée : pas de réécriture
  assert.equal(f.etat.ecrituresVariables.length, n);
});

test('N3 : 5000 issues tierces n\'empêchent pas l\'alerte grave de suppression (alerter filtre sur le robot)', async () => {
  const intrus = Array.from({ length: 5000 }, (_, i) => ({ number: i + 1, state: 'open', title: `spam ${i}`, body: '', user: { login: 'intrus' } }));
  const f = creerFake({ depots: [depot('a'), depot('b'), depot('c')], issues: intrus });
  f.etat.n = 6000;
  await lancer(f);
  delete f.etat.depots.c;
  const r = await lancer(f);
  assert.equal(r.graves, 1);
  assert.equal(f.etat.variables.ARRET, 'oui');
  assert.match(alertes(f)[0].title, /a disparu/);
  assert.ok(f.etat.urls.some((u) => u.includes('/issues?') && u.includes('creator=github-actions%5Bbot%5D')));
});

test('N3 : liste() échoue au lieu de tronquer quand pagesMax est atteint', async () => {
  const pleines = async (url) => new Response(JSON.stringify(Array.from({ length: 100 }, (_, i) => ({ id: i }))), { status: 200 });
  const api = creerApi({ token: 't', fetchImpl: pleines });
  await assert.rejects(api.liste('/x', { pagesMax: 3 }), /pagesMax|trop/);
  const fin = async (url) => new Response(JSON.stringify(new URL(url).searchParams.get('page') === '3' ? [{ id: 1 }] : Array.from({ length: 100 }, () => ({ id: 0 }))), { status: 200 });
  assert.equal((await creerApi({ token: 't', fetchImpl: fin }).liste('/x', { pagesMax: 3 })).length, 201);
});
