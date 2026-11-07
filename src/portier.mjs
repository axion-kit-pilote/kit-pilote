// Portier : un cycle sur tous les dépôts axion-kit portant le sujet kit-projet.
// Règles : docs/portier.md. Le jeton (GH_TOKEN) n'est jamais écrit dans le journal.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  ORG, marqueurDispatch, MAX_COMPARE, SUJET, arretDemande, creerApi, parserMotifs, analyserFichiers,
  etatCiAuSha, etatCiMain, comparer, verifierProtection, controlesPortier, poserSucces, teteInchangee,
  fusionnerSiTeteInchangee,
} from './lib.mjs';

const CHEMIN_MOTIFS = fileURLToPath(new URL('../chemins-sensibles.txt', import.meta.url));

async function alerter(ctx, o, r, problemes) {
  const { apiPilote, pilote, log } = ctx;
  const titre = `Portier : protection de main non conforme sur ${o}/${r}`;
  const ouvertes = await apiPilote.liste(`/repos/${pilote}/issues?state=open`);
  if (ouvertes.some((i) => !i.pull_request && i.title === titre)) {
    log(`  alerte déjà ouverte pour ${o}/${r}`);
    return;
  }
  await apiPilote.ecrire('POST', `/repos/${pilote}/issues`, {
    title: titre,
    body: `Le portier ignore ce dépôt tant que la protection de main n'est pas conforme :\n\n${problemes.map((p) => `- ${p}`).join('\n')}\n`,
  });
  log(`  alerte créée dans ${pilote}`);
}

async function traiterPr(ctx, depot, numero) {
  const { api, apiPilote, appId, motifs, pilote, log } = ctx;
  const o = ORG;
  const r = depot.name;
  const etiquette = `${r}#${numero}`;
  const pr = await api.lire(`/repos/${o}/${r}/pulls/${numero}`);
  if (pr.state !== 'open' || pr.base?.ref !== 'main') return log(`  ${etiquette} : ignorée (fermée ou base ≠ main)`);
  if (!pr.head?.repo || pr.head.repo.full_name.toLowerCase() !== `${o}/${r}`.toLowerCase())
    return log(`  ${etiquette} : ignorée (PR depuis un fork)`);
  if (pr.draft) return log(`  ${etiquette} : ignorée (brouillon)`);
  const H = pr.head.sha;
  if (!/^[0-9a-f]{40}$/.test(H ?? '')) return log(`  ${etiquette} : ignorée (tête illisible)`);

  const ci = await etatCiAuSha(api, o, r, H, numero);
  if (ci !== 'ok') return log(`  ${etiquette} : CI ${ci} à ${H.slice(0, 7)}, rien à faire`);

  // PR à jour avec main, sinon on attend la mise à jour (la CI à H ne dit rien du résultat fusionné).
  const retard = await comparer(api, o, r, 'main', H, { fichiers: false });
  if (retard.behind_by !== 0) return log(`  ${etiquette} : pas à jour avec main (retard ${retard.behind_by}), en attente de mise à jour`);

  // Fichiers : compare fixé sur H (jamais /pulls/n/files, qui montre la tête « du moment »).
  const cmp = await comparer(api, o, r, pr.base.sha, H);
  const raisons = cmp.trop ? [`liste de fichiers tronquée (${MAX_COMPARE} ou plus) ou illisible`] : analyserFichiers(cmp.fichiers, motifs);
  if (depot.name === 'kit-modele') raisons.push('dépôt kit-modele : toujours sensible');

  if (raisons.length > 0) {
    log(`  ${etiquette} : sensible (${raisons.slice(0, 3).join(' ; ')}${raisons.length > 3 ? ' ; …' : ''})`);
    let controle = (await controlesPortier(api, o, r, H, appId))[0];
    if (!controle) {
      const resume = `PR #${numero} sensible. En attente de l'approbation de Will.\n${raisons.slice(0, 20).join('\n')}`;
      controle = await api.ecrire('POST', `/repos/${o}/${r}/check-runs`, {
        name: 'portier', head_sha: H, status: 'in_progress',
        output: { title: 'attente Will', summary: resume },
      });
    }
    if (controle.status === 'completed' || controle.external_id === marqueurDispatch(H))
      return log(`  ${etiquette} : demande déjà envoyée pour ${H.slice(0, 7)}`);
    // Marqueur AVANT le dispatch (un cycle concurrent ne le double pas) ; retiré si le dispatch échoue.
    await api.ecrire('PATCH', `/repos/${o}/${r}/check-runs/${controle.id}`, { external_id: marqueurDispatch(H) });
    try {
      await apiPilote.ecrire('POST', `/repos/${pilote}/actions/workflows/porte.yml/dispatches`, {
        ref: ctx.ref, inputs: { repo: `${o}/${r}`, pr: String(numero), sha: H },
      });
    } catch (e) {
      await api.ecrire('PATCH', `/repos/${o}/${r}/check-runs/${controle.id}`, { external_id: '' });
      throw e;
    }
    return log(`  ${etiquette} : porte.yml lancé pour ${H.slice(0, 7)}`);
  }

  // Dernière relecture de la tête juste avant de poser le feu vert.
  if (!(await teteInchangee(api, o, r, numero, H))) return log(`  ${etiquette} : la tête a changé avant le feu vert, rien posé`);
  await poserSucces(api, o, r, H, appId, `PR #${numero} : CI verte, aucun chemin sensible.`);
  const res = await fusionnerSiTeteInchangee(api, o, r, numero, H);
  log(res.fusionne ? `  ${etiquette} : fusionnée à ${H.slice(0, 7)}` : `  ${etiquette} : non fusionnée, ${res.raison}`);
}

async function traiterDepot(ctx, depot) {
  const { api, appId, log } = ctx;
  const o = ORG;
  const r = depot.name;
  log(`Dépôt ${o}/${r}`);
  const problemes = await verifierProtection(api, o, r, appId);
  if (problemes.length > 0) {
    log(`  protection non conforme : ${problemes.join(' ; ')} -> dépôt ignoré`);
    return alerter(ctx, o, r, problemes);
  }
  const ciMain = await etatCiMain(api, o, r);
  if (ciMain !== 'ok') return log(`  CI de main : ${ciMain} -> dépôt ignoré ce cycle`);
  const prs = await api.liste(`/repos/${o}/${r}/pulls?state=open&base=main`);
  if (prs.length === 0) return log('  aucune PR ouverte');
  for (const p of prs) {
    if (!p.head?.repo || p.head.repo.full_name.toLowerCase() !== `${o}/${r}`.toLowerCase()) {
      log(`  ${r}#${p.number} : ignorée (PR depuis un fork)`);
      continue;
    }
    try { await traiterPr(ctx, depot, p.number); } catch (e) { ctx.erreurs++; log(`  ${r}#${p.number} : erreur, ${e.message}`); }
  }
}

export async function cycle({ env = process.env, fetchImpl = fetch, log = console.log, lireMotifs } = {}) {
  if (arretDemande(env.ARRET)) { log('ARRET=oui : le portier ne fait rien.'); return { erreurs: 0 }; }
  const appId = env.PORTIER_APP_ID;
  if (!/^\d+$/.test(appId ?? '')) throw new Error('PORTIER_APP_ID absent ou invalide');
  const pilote = env.GITHUB_REPOSITORY;
  if (!/^[\w.-]+\/[\w.-]+$/.test(pilote ?? '')) throw new Error('GITHUB_REPOSITORY absent ou invalide');
  if (!env.PILOTE_TOKEN) throw new Error('PILOTE_TOKEN absent (github.token du dépôt pilote)');
  const api = creerApi({ token: env.GH_TOKEN, fetchImpl });
  const apiPilote = creerApi({ token: env.PILOTE_TOKEN, fetchImpl });
  const texte = lireMotifs ? await lireMotifs() : await readFile(CHEMIN_MOTIFS, 'utf8');
  const ctx = { api, apiPilote, appId, pilote, ref: env.PORTIER_REF || 'main', motifs: parserMotifs(texte), log, erreurs: 0 };

  const depots = (await api.liste(`/orgs/${ORG}/repos?type=all`)).filter(
    (d) => !d.archived && (d.topics ?? []).includes(SUJET),
  );
  log(`${depots.length} dépôt(s) kit-projet à examiner.`);
  for (const d of depots) {
    try { await traiterDepot(ctx, d); } catch (e) { ctx.erreurs++; log(`  erreur sur ${d.name} : ${e.message}`); }
  }
  log('Cycle terminé.');
  return { erreurs: ctx.erreurs };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  cycle().then((r) => { if (r.erreurs > 0) process.exitCode = 1; })
    .catch((e) => { console.error(`Échec du portier : ${e.message}`); process.exitCode = 1; });
}
