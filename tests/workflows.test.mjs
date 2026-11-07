import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

const dossier = new URL('../.github/workflows/', import.meta.url);
const lire = (n) => readFileSync(new URL(n, dossier), 'utf8').replace(/\r\n/g, '\n');
const portier = lire('portier.yml');
const porte = lire('porte.yml');
const tous = readdirSync(dossier).map((n) => [n, lire(n)]);

test('garde : actions épinglées par SHA, pas de pull_request_target, inputs jamais dans run:', () => {
  for (const [n, t] of tous) {
    for (const l of t.split('\n').filter((x) => /^\s*-?\s*uses:/.test(x)))
      assert.match(l, /@[0-9a-f]{40}\b/, `${n} : ${l}`);
    assert.ok(!/pull_request_target/.test(t), n);
    // aucun run: ne contient d'interpolation ${{ … }}
    const lignes = t.split('\n');
    lignes.forEach((l, i) => { if (/^\s*-?\s*run:/.test(l)) assert.ok(!l.includes('${{'), `${n}:${i + 1}`); });
  }
});

test('I3 : client-id (variable), jeton restreint, secret en environnement', () => {
  for (const [n, t] of [['portier', portier], ['porte', porte]]) {
    assert.ok(!/app-id:/.test(t), n);
    assert.match(t, /client-id: \$\{\{ vars\.PORTIER_CLIENT_ID \}\}/, n);
    for (const p of ['checks: write', 'contents: write', 'pull-requests: write', 'administration: read', 'actions: read'])
      assert.ok(t.includes(`permission-${p}`), `${n} : permission-${p}`);
  }
  // C5 : le portier n'a pas besoin de modifier des workflows ; seule la porte (après Will) le garde
  assert.ok(!portier.includes('permission-workflows'), 'portier : pas de permission-workflows');
  assert.ok(porte.includes('permission-workflows: write'), 'porte : permission-workflows: write');
});

test('B3 : portier.yml : permissions du jeton du dépôt pilote et PILOTE_TOKEN', () => {
  assert.match(portier, /^permissions:\n  contents: read\n  actions: write\b[^\n]*\n  issues: write\b[^\n]*\n/m);
  assert.match(portier, /PILOTE_TOKEN: \$\{\{ github\.token \}\}/);
});

test('I2 : porte.yml : run-name, job résumé sans environnement, job protégé qui en dépend', () => {
  assert.match(porte, /^run-name: porte \$\{\{ inputs\.repo \}\}#\$\{\{ inputs\.pr \}\} @ \$\{\{ inputs\.sha \}\}$/m);
  const [, apres] = porte.split(/^jobs:\n/m);
  const jobs = apres.split(/^  (?=\w[\w-]*:\n)/m).filter(Boolean);
  const resume = jobs.find((j) => j.startsWith('resume:'));
  const protege = jobs.find((j) => j.startsWith('porte:'));
  assert.ok(resume && protege);
  assert.ok(!/environment:/.test(resume), 'le job résumé n\'a pas d\'environnement');
  assert.match(resume, /permissions:\n\s+contents: read/);
  assert.ok(!/secrets\./.test(resume));
  assert.match(protege, /needs: resume/);
  assert.match(protege, /environment: revue-will/);
});

test('C7 : .gitattributes impose eol=lf', () => {
  const t = readFileSync(new URL('../.gitattributes', import.meta.url), 'utf8');
  assert.match(t, /^\* text eol=lf$/m);
});
