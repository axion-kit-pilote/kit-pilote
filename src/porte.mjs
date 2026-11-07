// Porte : appelée par porte.yml après l'approbation de Will (environnement revue-will).
// Entrées par variables d'environnement : INPUT_REPO, INPUT_PR, INPUT_SHA.
import { fileURLToPath } from 'node:url';
import {
  ORG, marqueurDispatch, comparer, SUJET, REGEX_DEPOT, arretDemande, creerApi, etatCiAuSha, etatCiMain,
  verifierProtection, controlesPortier, poserSucces, teteInchangee, fusionnerSiTeteInchangee,
} from './lib.mjs';

export function lireEntrees(env) {
  const m = /^axion-kit\/([^/]+)$/.exec(env.INPUT_REPO ?? '');
  if (!m || !REGEX_DEPOT.test(m[1]) || m[1].includes('--')) throw new Error('repo invalide (attendu : axion-kit/<nom>)');
  if (!/^[1-9]\d{0,9}$/.test(env.INPUT_PR ?? '')) throw new Error('numéro de PR invalide');
  const sha = env.INPUT_SHA ?? '';
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error('sha invalide');
  return { r: m[1], n: Number(env.INPUT_PR), sha };
}

export async function porte({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  if (arretDemande(env.ARRET)) throw new Error('ARRET=oui : aucune fusion');
  const appId = env.PORTIER_APP_ID;
  if (!/^\d+$/.test(appId ?? '')) throw new Error('PORTIER_APP_ID absent ou invalide');
  const { r, n, sha } = lireEntrees(env);
  const api = creerApi({ token: env.GH_TOKEN, fetchImpl });

  const depot = await api.lire(`/repos/${ORG}/${r}`);
  if (depot.archived || !(depot.topics ?? []).includes(SUJET)) throw new Error(`dépôt sans le sujet ${SUJET} (ou archivé)`);
  const problemes = await verifierProtection(api, ORG, r, appId);
  if (problemes.length > 0) throw new Error(`protection de main non conforme : ${problemes.join(' ; ')}`);

  const pr = await api.lire(`/repos/${ORG}/${r}/pulls/${n}`);
  if (pr.state !== 'open' || pr.base?.ref !== 'main') throw new Error('PR fermée ou base ≠ main');
  if (pr.head?.repo?.full_name?.toLowerCase() !== `${ORG}/${r}`.toLowerCase()) throw new Error('PR depuis un fork');
  const tete = pr.head?.sha ?? '?';
  if (tete !== sha) throw new Error(`tête périmée : la PR est à ${tete.slice(0, 7)}, l'approbation visait ${sha.slice(0, 7)}`);
  const ci = await etatCiAuSha(api, ORG, r, sha, n);
  if (ci !== 'ok') throw new Error(`CI ${ci} à ${sha.slice(0, 7)}`);
  const ciMain = await etatCiMain(api, ORG, r);
  if (ciMain !== 'ok') throw new Error(`CI de main : ${ciMain}`);

  // Le contrôle « portier » de l'application, en cours, avec le marqueur de dispatch (external_id) : preuve que
  // le portier a lui-même lancé cette demande pour ce sha (un dispatch manuel n'en a pas).
  const controle = (await controlesPortier(api, ORG, r, sha, appId)).find(
    (c) => c.status !== 'completed' && c.external_id === marqueurDispatch(sha));
  if (!controle) throw new Error(`aucun contrôle portier en cours avec marqueur de dispatch à ${sha.slice(0, 7)} : demande non émise par le portier`);

  // Will peut approuver des heures après : la PR doit être toujours à jour avec main.
  const retard = await comparer(api, ORG, r, 'main', sha, { fichiers: false });
  if (retard.behind_by !== 0) throw new Error(`PR en retard sur main (retard ${retard.behind_by}) : mise à jour requise`);

  if (!(await teteInchangee(api, ORG, r, n, sha))) throw new Error('la tête a changé avant le feu vert');
  await poserSucces(api, ORG, r, sha, appId, `PR #${n} approuvée par Will pour ${sha}.`);
  const res = await fusionnerSiTeteInchangee(api, ORG, r, n, sha);
  if (!res.fusionne) throw new Error(res.raison);
  log(`${r}#${n} fusionnée à ${sha.slice(0, 7)} après approbation.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  porte().catch((e) => { console.error(`Porte refusée : ${e.message}`); process.exitCode = 1; });
}
