import test from 'node:test';
import assert from 'node:assert/strict';
import { resume, dateCourte, propre } from '../src/resume-quotidien.mjs';
import { creerFake, depot, envSonde, APP } from './fake6.mjs';

const T = Date.parse('2026-11-07T10:00:00Z');
const bot = { login: 'github-actions[bot]' };
function monde() {
  const a = depot('outil-a', {
    prs: [
      { number: 1, state: 'closed', title: 'Ajoute la page d\'accueil', merged_at: '2026-11-07T06:00:00Z', head: { sha: 's1' } },
      { number: 2, state: 'closed', title: 'Vieille fusion', merged_at: '2026-11-01T06:00:00Z', head: { sha: 's2' } },
      { number: 3, state: 'closed', title: 'Fermée sans fusion', merged_at: null, head: { sha: 's3' } },
      { number: 4, state: 'open', title: 'Change la config @will [clic](http://x)', head: { sha: 's4' } },
      { number: 5, state: 'open', title: 'En cours de CI', head: { sha: 's5' } },
    ],
    checks: {
      s4: [{ name: 'portier', status: 'in_progress', app: { id: Number(APP) } }],
      s5: [{ name: 'portier', status: 'completed', app: { id: Number(APP) } }],
    },
    contenus: { 'REPRENDRE.md': '# R\nETAT: phase 2 terminée\n' },
  });
  const b = depot('outil-b');
  const f = creerFake({ depots: [a, b, depot('hors', { topics: [] })], issues: [
    { number: 1, state: 'open', title: 'ALERTE : dérive de la protection de main sur axion-kit/x', user: bot, body: '' },
    { number: 2, state: 'open', title: 'Résumé du 06/11', user: bot, body: 'vieux' },
    { number: 3, state: 'open', title: 'ALERTE : faux', user: { login: 'intrus' }, body: '' },
    { number: 4, state: 'open', title: 'Résumé du 05/11', user: { login: 'intrus' }, body: '' },
  ] });
  return f;
}
const lancer = (f, env = {}) => resume({ env: envSonde(env), fetchImpl: f.fetch, maintenant: T, log: () => {} });

test('dateCourte : JJ/MM à Paris', () => {
  assert.equal(dateCourte(Date.parse('2026-11-07T10:00:00Z')), '07/11');
  assert.equal(dateCourte(Date.parse('2026-11-07T23:30:00Z')), '08/11'); // 00h30 à Paris
});

test('propre : mentions, liens, balises neutralisés', () => {
  assert.equal(propre('Salut @will [x](http://a) <b>`z`</b>'), 'Salut will xhttp a bz/b');
  assert.ok(propre('a'.repeat(300)).length <= 90);
});

test('résumé : sections, contenu simple, rien d\'un intrus, ancienne issue fermée', async () => {
  const f = monde();
  const r = await lancer(f);
  assert.equal(r.titre, 'Résumé du 07/11');
  assert.equal(r.fusionnees, 1); assert.equal(r.attente, 1); assert.equal(r.alertes, 1);
  assert.match(r.corps, /outil-a : Ajoute la page d'accueil/);
  assert.ok(!/Vieille fusion|Fermée sans fusion|En cours de CI/.test(r.corps));
  assert.ok(!r.corps.includes('@') && !r.corps.includes('://'));
  assert.match(r.corps, /outil-a : phase 2 terminée/);
  assert.match(r.corps, /outil-b : pas de fiche de reprise/);
  assert.ok(!r.corps.includes('hors'));
  assert.ok(!/faux/.test(r.corps));
  assert.match(r.corps, /Tout tourne normalement/);
  assert.ok(!/\b(SHA|PR|workflow|ruleset|API|check)\b/i.test(r.corps), 'pas de jargon');
  const nouvelle = f.etat.issues.find((i) => i.title === 'Résumé du 07/11');
  assert.ok(nouvelle);
  assert.equal(f.etat.issues.find((i) => i.number === 2).state, 'closed');
  assert.equal(f.etat.issues.find((i) => i.number === 4).state, 'open'); // issue d'un intrus : pas touchée
});

test('relance le même jour : met à jour sans doublon', async () => {
  const f = monde();
  await lancer(f); await lancer(f);
  assert.equal(f.etat.issues.filter((i) => i.title === 'Résumé du 07/11').length, 1);
});

test('ARRET=oui est annoncé en tête', async () => {
  const r = await lancer(monde(), { ARRET: 'oui' });
  assert.match(r.corps, /^\*\*Tout est arrêté/);
});

test('un dépôt illisible est signalé sans faire échouer le résumé', async () => {
  const f = monde();
  f.etat.refus.add('/repos/axion-kit/outil-b/pulls');
  const r = await lancer(f);
  assert.match(r.corps, /Je n'ai pas pu lire\n- outil-b/);
});

test('S8 : REPRENDRE.md lu sur la branche etat, main à défaut', async () => {
  const a = depot('a', { contenus: { 'REPRENDRE.md': 'ETAT: vieux sur main\n' }, contenusEtat: { 'REPRENDRE.md': 'ETAT: frais sur etat\n' } });
  const b = depot('b', { contenus: { 'REPRENDRE.md': 'ETAT: seulement main\n' } });
  const c = depot('c');
  const f = creerFake({ depots: [a, b, c] });
  const r = await lancer(f);
  assert.match(r.corps, /a : frais sur etat/);
  assert.match(r.corps, /b : seulement main/);
  assert.match(r.corps, /c : pas de fiche de reprise/);
  assert.ok(f.etat.urls.includes('GET /repos/axion-kit/a/contents/REPRENDRE.md?ref=etat'));
});
