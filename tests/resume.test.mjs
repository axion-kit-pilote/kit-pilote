import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resume } from '../src/resume.mjs';
import { JETON_PILOTE, sha, creerDepot, ajouterPr, creerFake } from './fake.mjs';

const H = sha('a');
async function lancerResume(w, extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'resume-'));
  const f = join(dir, 'summary.md');
  await writeFile(f, '');
  await resume({ env: { GH_TOKEN: JETON_PILOTE, INPUT_REPO: 'axion-kit/projet', INPUT_PR: '1', INPUT_SHA: H, GITHUB_STEP_SUMMARY: f, ...extra }, fetchImpl: w.fake.fetch, log() {} });
  return readFile(f, 'utf8');
}
function monde(opts) {
  const d = creerDepot('projet');
  ajouterPr(d, 1, opts);
  return { d, fake: creerFake({ depots: [d] }) };
}

test('I2 : le résumé liste les fichiers et stats du compare fixé sur sha', async () => {
  const w = monde({ fichiers: [{ filename: '.github/workflows/ci.yml', status: 'modified', additions: 3, deletions: 1 }, { filename: 'a.js', previous_filename: 'b.js', status: 'renamed', additions: 0, deletions: 0 }] });
  const s = await lancerResume(w);
  assert.match(s, /\.github\/workflows\/ci\.yml/);
  assert.match(s, /b\.js/);
  assert.match(s, new RegExp(H));
  assert.ok(w.fake.etat.appels.some((a) => a.includes(`...${H}`)));
  assert.equal(w.d.checks.length, 0);
  assert.equal(w.d.merges.length, 0);
});

test('I2 : noms de fichiers piégés (backticks, retours à la ligne) neutralisés dans le résumé', async () => {
  const w = monde({ fichiers: [{ filename: 'a```\n# APPROUVÉ\n```x', status: 'added' }] });
  const s = await lancerResume(w);
  assert.ok(!/^# APPROUVÉ/m.test(s));
});

test('I2 : repo hors axion-kit ou sha invalide : refus', async () => {
  const w = monde({});
  await assert.rejects(lancerResume(w, { INPUT_REPO: 'autre/projet' }));
  await assert.rejects(lancerResume(w, { INPUT_REPO: 'axion-kit/..' }));
  await assert.rejects(lancerResume(w, { INPUT_SHA: 'zz' }));
});

test('C6 : caractères bidi et espaces de largeur nulle neutralisés', async () => {
  const w = monde({ fichiers: [{ filename: 'a\u202Eb\u2066c\u2069d\u200Be\u200Ff.js', status: 'added' }] });
  const s = await lancerResume(w);
  assert.ok(!/[\u202A-\u202E\u2066-\u2069\u200B-\u200F]/.test(s));
  assert.match(s, /a\?b\?c\?d\?e\?f\.js/);
});

test('R3 : U+2028, U+2029, U+061C, U+FEFF, U+180E neutralisés', async () => {
  const w = monde({ fichiers: [{ filename: 'a b c؜d﻿e᠎f.js', status: 'added' }] });
  const s = await lancerResume(w);
  assert.match(s, /a\?b\?c\?d\?e\?f\.js/);
});
