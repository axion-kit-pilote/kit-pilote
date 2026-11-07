// Résumé de la demande : exécuté par le 1er job de porte.yml (sans environnement, sans secret).
// Écrit dans $GITHUB_STEP_SUMMARY les fichiers et statistiques du compare fixé sur INPUT_SHA,
// à lire avant d'approuver le job protégé. Lecture seule.
import { appendFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ORG, creerApi, comparer, MAX_COMPARE } from './lib.mjs';
import { lireEntrees } from './porte.mjs';

// Un nom de fichier vient de la PR : jamais de backtick ni de retour à la ligne dans le résumé.
const propre = (t) => String(t).replace(/[^\x20-\x7e -￿]|`|[\u202A-\u202E\u2066-\u2069\u200B-\u200F\u2028\u2029\u061C\uFEFF\u180E]/g, '?');

export async function resume({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const { r, n, sha } = lireEntrees(env);
  const api = creerApi({ token: env.GH_TOKEN, fetchImpl });
  const pr = await api.lire(`/repos/${ORG}/${r}/pulls/${n}`);
  const base = pr.base?.sha;
  if (!/^[0-9a-f]{40}$/.test(base ?? '')) throw new Error('base de la PR illisible');
  const cmp = await comparer(api, ORG, r, base, sha);
  const f = cmp.fichiers;
  const somme = (k) => f.reduce((a, x) => a + (Number(x[k]) || 0), 0);
  const statuts = {};
  for (const x of f) statuts[x.status] = (statuts[x.status] ?? 0) + 1;
  const lignes = [
    `## Demande de porte : ${ORG}/${r}#${n}`,
    '',
    `- SHA approuvé : \`${sha}\``,
    `- Tête actuelle de la PR : \`${propre(pr.head?.sha ?? '?')}\`${pr.head?.sha === sha ? '' : ' (**différente : la porte refusera**)'}`,
    `- Fichiers : ${f.length}${cmp.trop ? ` (**liste tronquée (${MAX_COMPARE} ou plus) ou illisible : à vérifier à la main**)` : ''}, +${somme('additions')} -${somme('deletions')}`,
    `- Statuts : ${Object.entries(statuts).map(([k, v]) => `${propre(k)} ${v}`).join(', ') || 'aucun'}`,
    '',
    '```text',
    ...f.map((x) => `${propre(x.status)}\t${propre(x.filename)}${x.previous_filename ? ` (depuis ${propre(x.previous_filename)})` : ''}`),
    '```',
    '',
  ].join('\n');
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, lignes);
  log(lignes);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resume().catch((e) => { console.error(`Résumé impossible : ${e.message}`); process.exitCode = 1; });
}
