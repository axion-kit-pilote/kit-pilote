import test from 'node:test';
import assert from 'node:assert/strict';
import { reactiver, vivant, WORKFLOWS } from '../src/reveil.mjs';
import { creerFake, envSonde } from './fake6.mjs';

const alertes = (f) => f.etat.issues.filter((i) => i.title.startsWith('ALERTE'));
const T = Date.parse('2026-11-07T12:00:00Z');

test('S9 : un workflow éteint par inactivité est réactivé (PUT .../enable), les actifs sont laissés', async () => {
  const f = creerFake();
  f.etat.workflows['sonde.yml'] = 'disabled_inactivity';
  f.etat.workflows['portier.yml'] = 'disabled_inactivity';
  const b = await reactiver({ env: envSonde(), fetchImpl: f.fetch, log: () => {} });
  assert.deepEqual(b.reactives.sort(), ['portier.yml', 'sonde.yml']);
  assert.ok(Object.values(f.etat.workflows).every((x) => x === 'active'));
  assert.match(alertes(f)[0].title, /éteintes par GitHub/);
});

test('N : PUT .../enable sur CHAQUE workflow à chaque passage (reveil.yml compris), même actifs ; aucune alerte', async () => {
  assert.deepEqual(WORKFLOWS, ['portier.yml', 'sonde.yml', 'surveiller.yml', 'resume-quotidien.yml', 'reveil.yml']);
  const f = creerFake();
  await reactiver({ env: envSonde(), fetchImpl: f.fetch, log: () => {} });
  const puts = f.etat.appels.filter((a) => a.startsWith('PUT') && a.endsWith('/enable'));
  assert.equal(puts.length, 5);
  assert.equal(alertes(f).length, 0);
  await reactiver({ env: envSonde(), fetchImpl: f.fetch, log: () => {} });
  assert.equal(f.etat.appels.filter((a) => a.startsWith('PUT') && a.endsWith('/enable')).length, 10);
});

test('N : un workflow éteint à la main est aussi rallumé (PUT enable) et signalé par une alerte', async () => {
  const f = creerFake();
  f.etat.workflows['surveiller.yml'] = 'disabled_manually';
  await reactiver({ env: envSonde(), fetchImpl: f.fetch, log: () => {} });
  assert.equal(f.etat.workflows['surveiller.yml'], 'active');
  assert.match(alertes(f)[0].title, /étaient éteintes/);
});

test('S9 : réactivation refusée -> alerte, échec signalé', async () => {
  const f = creerFake();
  f.etat.workflows['sonde.yml'] = 'disabled_inactivity';
  f.etat.sansDroitActions = true;
  const b = await reactiver({ env: envSonde(), fetchImpl: f.fetch, log: () => {} });
  assert.equal(b.echecs.length, 5);     // chaque PUT .../enable est refusé
  assert.ok(alertes(f).some((i) => /a échoué/.test(i.title)));
});

test('S9 : battement mensuel horodaté, branche créée au besoin, rien si récent', async () => {
  const f = creerFake({ vivant: null });
  assert.equal(await vivant({ env: envSonde(), fetchImpl: f.fetch, maintenant: T, log: () => {} }), 'écrit');
  assert.equal(f.etat.vivant, 'vivant : 2026-11-07T12:00:00.000Z\n');
  assert.equal(f.etat.dernierPut.branch, 'vivant');
  assert.equal(await vivant({ env: envSonde(), fetchImpl: f.fetch, maintenant: T + 3 * 24 * 3600 * 1000, log: () => {} }), 'récent');
  assert.equal(await vivant({ env: envSonde(), fetchImpl: f.fetch, maintenant: T + 30 * 24 * 3600 * 1000, log: () => {} }), 'écrit');
  assert.equal(f.etat.dernierPut.sha, 'sv');
});

test('S9 : écriture impossible -> alerte', async () => {
  const f = creerFake({ vivant: null });
  f.etat.sansDroitContenu = true;
  assert.equal(await vivant({ env: envSonde(), fetchImpl: f.fetch, maintenant: T, log: () => {} }), 'échec');
  assert.match(alertes(f)[0].title, /battement mensuel/);
});
