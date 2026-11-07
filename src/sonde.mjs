// Sonde horaire (L6) : dérive des protections, installations, nombre de dépôts, vie du portier.
// Écart -> issue d'alerte dans le dépôt pilote ; écart grave -> variable ARRET=oui.
// La sonde ne lève jamais ARRET : seul Will reprend (docs/ARRET.md).
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  ORG, ORG_PILOTE, PILOTE_PAR_DEFAUT, SUJET, arretDemande, creerApi, alerter,
} from './client6.mjs';

export const INSTALLATIONS_ATTENDUES = ['claude', 'kit-portier', 'kit-createur'];
export const AGE_MAX_PORTIER_MS = 60 * 60 * 1000;
export const AGE_MAX_VIVANT_MS = 40 * 24 * 3600 * 1000;
export const TAILLE_MAX_MEMOIRE = 40000;   // une variable Actions accepte 48 Ko
const DEPOT_MODELE = 'kit-modele';

// ---- protection de main d'un dépôt ----
export async function controlerDepot(api, o, r, appId, avertissements = []) {
  const res = await api.requete('GET', `/repos/${o}/${r}/branches/main/protection`);
  if (res.status === 404) return ['main n\'a aucune protection'];
  if (!res.ok) throw new Error(`protection de ${r} illisible (${res.status})`);
  const p = res.data;
  const pb = [];
  const controles = p.required_status_checks?.checks ?? [];
  if (!controles.some((c) => c.context === 'portier' && String(c.app_id) === String(appId)))
    pb.push(`main n'exige pas le contrôle « portier » limité à l'application ${appId}`);
  if (controles.some((c) => c.context === 'portier' && String(c.app_id) !== String(appId)))
    pb.push('le contrôle « portier » peut être fourni par une autre application');
  if (!p.enforce_admins?.enabled) pb.push('les administrateurs ne sont pas soumis aux règles (enforce_admins)');
  if (p.allow_force_pushes?.enabled !== false) pb.push('les force-push ne sont pas interdits');
  if (p.allow_deletions?.enabled !== false) pb.push('la suppression de main n\'est pas interdite');
  // Rulesets effectifs sur main + rulesets du dépôt : aucun contournement toléré.
  const rg = await api.requete('GET', `/repos/${o}/${r}/rules/branches/main`);
  if (!rg.ok && rg.status !== 404) throw new Error(`règles de main de ${r} illisibles (${rg.status})`);
  const vus = new Map();
  for (const x of rg.ok && Array.isArray(rg.data) ? rg.data : []) vus.set(`${x.ruleset_source_type}:${x.ruleset_id}`, x);
  const rl = await api.requete('GET', `/repos/${o}/${r}/rulesets?includes_parents=true`);
  for (const x of rl.ok && Array.isArray(rl.data) ? rl.data : []) vus.set(`${x.source_type ?? 'Repository'}:${x.id}`, { ruleset_source_type: x.source_type ?? 'Repository', ruleset_id: x.id });
  // Un seul endpoint, celui du dépôt, avec les rulesets hérités de l'organisation :
  // l'endpoint d'organisation demande un droit que la sonde n'a pas.
  for (const x of vus.values()) {
    const rs = await api.requete('GET', `/repos/${o}/${r}/rulesets/${x.ruleset_id}?includes_parents=true`);
    if (!rs.ok) pb.push(`ruleset ${x.ruleset_id} illisible (${rs.status})`);
    else if (!Array.isArray(rs.data?.bypass_actors)) avertissements.push(`${o}/${r} : ruleset ${x.ruleset_id} : liste des contournements non fournie (droit « administration : lecture » manquant ?)`);
    else if (rs.data.bypass_actors.length > 0) pb.push(`le ruleset ${x.ruleset_id} autorise des contournements`);
  }
  return pb;
}

// Branche « etat » : ni force-push ni suppression (protection classique ou règles).
export async function controlerEtat(api, o, r) {
  const b = await api.requete('GET', `/repos/${o}/${r}/branches/etat`);
  if (b.status === 404) return [];             // pas encore créée
  if (!b.ok) throw new Error(`branche etat de ${r} illisible (${b.status})`);
  const pr = await api.requete('GET', `/repos/${o}/${r}/branches/etat/protection`);
  if (!pr.ok && pr.status !== 404) throw new Error(`protection de etat de ${r} illisible (${pr.status})`);
  const rg = await api.requete('GET', `/repos/${o}/${r}/rules/branches/etat`);
  if (!rg.ok && rg.status !== 404) throw new Error(`règles de etat de ${r} illisibles (${rg.status})`);
  const types = new Set((rg.ok && Array.isArray(rg.data) ? rg.data : []).map((x) => x.type));
  const pb = [];
  if (!(pr.ok && pr.data?.allow_force_pushes?.enabled === false) && !types.has('non_fast_forward')) pb.push('les force-push ne sont pas interdits sur la branche etat');
  if (!(pr.ok && pr.data?.allow_deletions?.enabled === false) && !types.has('deletion')) pb.push('la suppression de la branche etat n\'est pas interdite');
  return pb;
}

async function poserArret({ apiArret, pilote }) {
  const corps = { name: 'ARRET', value: 'oui' };
  let r = await apiArret.requete('PATCH', `/repos/${pilote}/actions/variables/ARRET`, corps);
  if (r.status === 404) r = await apiArret.requete('POST', `/repos/${pilote}/actions/variables`, corps);
  return r.ok;
}

// Mémoire : ensemble des id de dépôts, JSON compact, dans la VARIABLE Actions SONDE_MEMOIRE de kit-pilote
// (écrite avec ARRET_TOKEN) : une variable n'est pas publique et personne d'autre ne peut la forger ni la noyer
// sous des issues. Trop longue pour une variable (48 Ko) : nombre + condensé SHA-256 des id triés.
export const condense = (ids) => createHash('sha256').update(ids.join(',')).digest('hex');
export const VARIABLE_MEMOIRE = 'SONDE_MEMOIRE';
async function lireMemoire(apiVar, pilote) {
  const vide = { ids: null, n: null, h: null, existe: false };
  const r = await apiVar.requete('GET', `/repos/${pilote}/actions/variables/${VARIABLE_MEMOIRE}`);
  if (r.status === 404) return vide;
  if (!r.ok) throw new Error(`lecture de la mémoire -> ${r.status} (jeton sans droit « Variables » ?)`);
  const valeur = String(r.data?.value ?? '');
  try {
    const j = JSON.parse(valeur.split('\n')[0]);
    if (Array.isArray(j.ids) && j.ids.every((x) => Number.isSafeInteger(x))) return { ...vide, existe: true, ids: j.ids, n: j.ids.length };
    if (Number.isSafeInteger(j.n) && /^[0-9a-f]{64}$/.test(j.h)) return { ...vide, existe: true, n: j.n, h: j.h };
  } catch { /* ancien format ci-dessous */ }
  const m = /nb_depots=(\d+)/.exec(valeur);
  return { ...vide, existe: true, n: m ? Number(m[1]) : null };
}
async function ecrireMemoire(apiVar, pilote, memoire, ids) {
  let corps = JSON.stringify({ ids });
  if (corps.length > TAILLE_MAX_MEMOIRE) corps = JSON.stringify({ n: ids.length, h: condense(ids) });
  const donnees = { name: VARIABLE_MEMOIRE, value: corps };
  let r = memoire.existe ? await apiVar.requete('PATCH', `/repos/${pilote}/actions/variables/${VARIABLE_MEMOIRE}`, donnees) : { status: 404 };
  if (r.status === 404) r = await apiVar.requete('POST', `/repos/${pilote}/actions/variables`, donnees);
  if (!r.ok) throw new Error(`mémoire des dépôts -> ${r.status}`);
}

export async function sonde({ env = process.env, fetchImpl = fetch, maintenant = Date.now(), log = console.log } = {}) {
  const pilote = env.GITHUB_REPOSITORY || PILOTE_PAR_DEFAUT;
  const appId = env.PORTIER_APP_ID;
  if (!appId) throw new Error('PORTIER_APP_ID absent');
  const api = creerApi({ token: env.GH_TOKEN, fetchImpl });
  const apiPilote = creerApi({ token: env.PILOTE_TOKEN, fetchImpl });
  const apiOrg = env.ORG_TOKEN ? creerApi({ token: env.ORG_TOKEN, fetchImpl }) : api;
  const apiArret = creerApi({ token: env.ARRET_TOKEN || env.PILOTE_TOKEN, fetchImpl });
  const ecarts = [];     // { titre, grave, lignes }
  const avertissements = [];
  const grave = (titre, lignes) => ecarts.push({ titre, grave: true, lignes });
  // Sonde aveugle ou sans pouvoir d'arrêt : grave (on ne se tait pas faute de jeton).
  if (!env.ORG_TOKEN) grave('la sonde n\'a pas le jeton ORG_TOKEN', ['Secret SONDE_ORG_TOKEN absent : les installations des organisations ne sont pas contrôlées de façon fiable.']);
  if (!env.ARRET_TOKEN) grave('la sonde n\'a pas le jeton ARRET_TOKEN', ['Secret SONDE_ARRET_TOKEN absent : la sonde ne peut pas poser ARRET automatiquement.']);

  // 1. dépôts et protection de main
  const depots = await api.liste(`/orgs/${ORG}/repos?type=all`);
  const controles = depots.filter((x) => ((x.topics ?? []).includes(SUJET) || x.name === DEPOT_MODELE) && !x.archived);
  for (const d of controles) {
    try {
      const av = [];
      const pb = await controlerDepot(api, ORG, d.name, appId, av);
      avertissements.push(...av);
      if (d.name !== DEPOT_MODELE || (d.topics ?? []).includes(SUJET)) pb.push(...await controlerEtat(api, ORG, d.name));
      if (pb.length) grave(`dérive de la protection de main sur ${ORG}/${d.name}`, pb);
    } catch (e) { avertissements.push(`${ORG}/${d.name} : ${e.message}`); }
  }

  // 2. installations de l'organisation = liste attendue
  try {
    const d = await apiOrg.lire(`/orgs/${ORG}/installations?per_page=100`);
    const slugs = (d.installations ?? []).map((i) => i.app_slug).sort();
    const en_trop = slugs.filter((s) => !INSTALLATIONS_ATTENDUES.includes(s));
    const manquantes = INSTALLATIONS_ATTENDUES.filter((s) => !slugs.includes(s));
    if (en_trop.length) grave(`application inattendue installée sur ${ORG}`, en_trop.map((s) => `installation inattendue : ${s}`));
    if (manquantes.length) ecarts.push({ titre: `application attendue absente de ${ORG}`, grave: false, lignes: manquantes.map((s) => `installation manquante : ${s}`) });
  } catch (e) { avertissements.push(`installations de ${ORG} : ${e.message}`); }

  // 3. axion-kit-pilote : aucune installation
  try {
    const d = await apiOrg.lire(`/orgs/${ORG_PILOTE}/installations?per_page=100`);
    const slugs = (d.installations ?? []).map((i) => i.app_slug);
    if (slugs.length) grave(`application installée sur ${ORG_PILOTE}`, slugs.map((s) => `installation présente : ${s}`));
  } catch (e) { avertissements.push(`installations de ${ORG_PILOTE} : ${e.message}`); }

  // 4. dépôts : aucun id ne doit disparaître (supprimer puis recréer ne contourne plus)
  const ids = [...new Set(depots.map((d) => d.id).filter((x) => Number.isSafeInteger(x)))].sort((x, y) => x - y);
  let memoire = null;
  try { memoire = await lireMemoire(apiArret, pilote); } catch (e) { avertissements.push(`mémoire des dépôts : ${e.message}`); }
  if (memoire) {
    if (memoire.ids) {
      const manquants = memoire.ids.filter((x) => !ids.includes(x));
      if (manquants.length) grave(`un dépôt de ${ORG} a disparu`, [`dépôts disparus : ${manquants.length} (id ${manquants.slice(0, 20).join(', ')})`, `avant : ${memoire.ids.length}, maintenant : ${ids.length}`]);
    } else if (memoire.h) {
      if (ids.length < memoire.n || (ids.length === memoire.n && condense(ids) !== memoire.h))
        grave(`un dépôt de ${ORG} a disparu`, [`avant : ${memoire.n}, maintenant : ${ids.length} (ensemble modifié)`]);
    } else if (memoire.n !== null && ids.length < memoire.n) {
      grave(`un dépôt de ${ORG} a disparu`, [`avant : ${memoire.n}, maintenant : ${ids.length}`]);
    }
    const identique = memoire.ids ? memoire.ids.length === ids.length && memoire.ids.every((x, k) => x === ids[k]) : false;
    if (!identique) {
      try { await ecrireMemoire(apiArret, pilote, memoire, ids); } catch (e) { avertissements.push(`mémoire des dépôts : ${e.message}`); }
    }
  }

  // 5. le portier tourne-t-il ?
  try {
    const d = await apiPilote.lire(`/repos/${pilote}/actions/workflows/portier.yml/runs?per_page=1`);
    const dernier = (d.workflow_runs ?? [])[0];
    const age = dernier ? maintenant - Date.parse(dernier.created_at) : Infinity;
    if (!(age <= AGE_MAX_PORTIER_MS))
      ecarts.push({ titre: 'le portier ne tourne plus', grave: false, lignes: [dernier ? `dernier cycle il y a plus de 60 minutes (${dernier.created_at})` : 'aucun cycle trouvé'] });
  } catch (e) { avertissements.push(`cycles du portier : ${e.message}`); }

  // 6. battement mensuel (vivant.txt, branche vivant) : sans lui, le cron peut s'éteindre au bout de 60 jours
  try {
    const v = await apiPilote.requete('GET', `/repos/${pilote}/contents/vivant.txt?ref=vivant`);
    let age = Infinity;
    if (v.ok) {
      const t = /(\d{4}-\d{2}-\d{2}T[\d:.]+Z)/.exec(Buffer.from(v.data?.content ?? '', 'base64').toString('utf8'));
      if (t) age = maintenant - Date.parse(t[1]);
    } else if (v.status !== 404) throw new Error(`vivant.txt -> ${v.status}`);
    if (!(age <= AGE_MAX_VIVANT_MS))
      ecarts.push({ titre: 'le battement mensuel du dépôt pilote est absent', grave: false, lignes: ['vivant.txt (branche vivant) est absent ou date de plus de 40 jours : les tâches planifiées risquent d\'être éteintes par GitHub après 60 jours sans activité (voir docs/ARRET.md et REPRENDRE-L6.md).'] });
  } catch (e) { avertissements.push(`battement mensuel : ${e.message}`); }

  // Écriture des alertes
  for (const e of ecarts) {
    const neuve = await alerter(apiPilote, pilote, e.titre, e.lignes);
    log(`écart${e.grave ? ' GRAVE' : ''} : ${e.titre}${neuve ? ' (alerte créée)' : ' (alerte déjà ouverte)'}`);
  }
  const graves = ecarts.filter((e) => e.grave);
  let arret = 'non';
  if (graves.length) {
    if (arretDemande(env.ARRET)) arret = 'déjà posé';
    else if (await poserArret({ apiArret, pilote })) arret = 'posé';
    else {
      arret = 'échec';
      await alerter(apiPilote, pilote, 'la sonde n\'a pas pu poser ARRET', [
        'Écart grave constaté mais la variable ARRET n\'a pas pu être écrite (droit manquant).',
        `À faire à la main : gh variable set ARRET --body oui -R ${pilote}`,
      ]);
    }
    log(`ARRET : ${arret}`);
  }
  if (avertissements.length) {
    await alerter(apiPilote, pilote, 'contrôles de la sonde impossibles', avertissements);
    log(`${avertissements.length} contrôle(s) impossible(s)`);
  }
  return { ecarts, graves: graves.length, arret, avertissements };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  sonde().then((r) => { if (r.arret === 'échec') process.exitCode = 1; }).catch((e) => { console.error(e.message); process.exitCode = 1; });
}
