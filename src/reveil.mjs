// Réveil (L6) : GitHub éteint les tâches planifiées d'un dépôt public sans activité depuis 60 jours.
//  - `reactiver` : appelle PUT .../actions/workflows/{id}/enable sur CHAQUE workflow (portier, sonde,
//    surveiller, resume-quotidien, reveil lui-même) à chaque passage. Éteint par inactivité ou à la main : rallumé + alerte.
//  - `vivant` : un commit mensuel horodaté dans vivant.txt (branche « vivant »), pour que le dépôt ne soit
//    jamais inactif 60 jours. Échec -> alerte.
// Limite : si tout le dépôt est inactif ET que ce workflow lui-même est éteint, rien ne peut le rallumer :
// d'où le battement mensuel, que la sonde surveille (alerte au bout de 40 jours).
import { fileURLToPath } from 'node:url';
import { PILOTE_PAR_DEFAUT, creerApi, alerter } from './client6.mjs';

export const WORKFLOWS = ['portier.yml', 'sonde.yml', 'surveiller.yml', 'resume-quotidien.yml', 'reveil.yml'];
export const BRANCHE_VIVANT = 'vivant';
export const INTERVALLE_VIVANT_MS = 25 * 24 * 3600 * 1000;

export async function reactiver({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const pilote = env.GITHUB_REPOSITORY || PILOTE_PAR_DEFAUT;
  const api = creerApi({ token: env.PILOTE_TOKEN, fetchImpl });
  const bilan = { reactives: [], manuels: [], echecs: [] };
  for (const f of WORKFLOWS) {
    const w = await api.requete('GET', `/repos/${pilote}/actions/workflows/${f}`);
    if (!w.ok) { bilan.echecs.push(`${f} : lecture impossible (${w.status})`); continue; }
    const etat = w.data?.state;
    // PUT .../enable à CHAQUE passage, sur chaque workflow (même actif, reveil.yml compris) : sans effet s'il est
    // déjà actif, et un workflow éteint (inactivité ou à la main) est rallumé aussitôt.
    const r = await api.requete('PUT', `/repos/${pilote}/actions/workflows/${w.data?.id ?? f}/enable`);
    if (!r.ok) { bilan.echecs.push(`${f} : activation refusée (${r.status})`); continue; }
    if (etat === 'active') continue;
    if (etat === 'disabled_inactivity') { bilan.reactives.push(f); log(`${f} : réactivé`); }
    else { bilan.manuels.push(`${f} : ${etat}`); log(`${f} : rallumé (état ${etat})`); }
  }
  if (bilan.reactives.length) await alerter(api, pilote, 'des tâches planifiées avaient été éteintes par GitHub', bilan.reactives.map((f) => `réactivé : ${f}`));
  if (bilan.manuels.length) await alerter(api, pilote, 'des tâches planifiées étaient éteintes', bilan.manuels.map((l) => `${l} : rallumé (éteint autrement que par inactivité : à vérifier, quelqu'un l'a peut-être éteint)`));
  if (bilan.echecs.length) await alerter(api, pilote, 'le réveil des tâches planifiées a échoué', bilan.echecs);
  return bilan;
}

export async function vivant({ env = process.env, fetchImpl = fetch, maintenant = Date.now(), log = console.log } = {}) {
  const pilote = env.GITHUB_REPOSITORY || PILOTE_PAR_DEFAUT;
  const api = creerApi({ token: env.PILOTE_TOKEN, fetchImpl });
  try {
    const cur = await api.requete('GET', `/repos/${pilote}/contents/vivant.txt?ref=${BRANCHE_VIVANT}`);
    if (cur.ok) {
      const t = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(Buffer.from(cur.data?.content ?? '', 'base64').toString('utf8'));
      if (t && maintenant - Date.parse(t[1]) < INTERVALLE_VIVANT_MS) { log('vivant : battement récent, rien à faire'); return 'récent'; }
    } else if (cur.status !== 404) throw new Error(`lecture ${cur.status}`);
    const b = await api.requete('GET', `/repos/${pilote}/branches/${BRANCHE_VIVANT}`);
    if (b.status === 404) {
      const d = await api.lire(`/repos/${pilote}`);
      const ref = await api.lire(`/repos/${pilote}/git/ref/heads/${d.default_branch}`);
      const c = await api.requete('POST', `/repos/${pilote}/git/refs`, { ref: `refs/heads/${BRANCHE_VIVANT}`, sha: ref.object.sha });
      if (!c.ok) throw new Error(`création de la branche ${c.status}`);
    } else if (!b.ok) throw new Error(`branche ${b.status}`);
    const horodatage = new Date(maintenant).toISOString();
    const corps = { message: `vivant : ${horodatage}`, content: Buffer.from(`vivant : ${horodatage}\n`).toString('base64'), branch: BRANCHE_VIVANT };
    if (cur.ok && cur.data?.sha) corps.sha = cur.data.sha;
    const w = await api.requete('PUT', `/repos/${pilote}/contents/vivant.txt`, corps);
    if (!w.ok) throw new Error(`écriture ${w.status}`);
    log(`vivant : ${horodatage}`);
    return 'écrit';
  } catch (e) {
    await alerter(api, pilote, 'le battement mensuel n\'a pas pu être écrit', [`vivant.txt (branche ${BRANCHE_VIVANT}) : ${e.message}. Sans activité pendant 60 jours, GitHub éteint les tâches planifiées.`]);
    log('vivant : échec');
    return 'échec';
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [, , mode] = process.argv;
  const f = mode === 'vivant' ? vivant : mode === 'reactiver' ? reactiver : null;
  if (!f) { console.error('usage : reveil.mjs reactiver|vivant'); process.exitCode = 2; }
  else f().then((r) => { if (r === 'échec' || r?.echecs?.length) process.exitCode = 1; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
