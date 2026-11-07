// Outils communs au portier et à la porte. Aucune dépendance.
export const ORG = 'axion-kit';
// Marqueur de dispatch : external_id du contrôle portier (champ que seul le portier écrit), jamais le résumé.
export const marqueurDispatch = (sha) => `dispatch:${sha}`;
// L'API compare tronque la liste à 300 fichiers : à partir de 300, on ne sait plus -> sensible.
export const MAX_COMPARE = 300;
export const SUJET = 'kit-projet';
// Nom de dépôt strict (même règle que kit-nouveau) : jamais « .. », « / » ni majuscule.
export const REGEX_DEPOT = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
export const arretDemande = (v) => String(v ?? '').trim().toLowerCase() === 'oui';

export class ErreurApi extends Error {}

export function creerApi({ token, fetchImpl = fetch, base = 'https://api.github.com' }) {
  if (!token) throw new Error('GH_TOKEN absent');
  async function requete(methode, chemin, corps) {
    const res = await fetchImpl(base + chemin, {
      method: methode,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kit-portier',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const texte = await res.text();
    let data = null;
    if (texte) { try { data = JSON.parse(texte); } catch { data = texte; } }
    return { status: res.status, ok: res.ok, data };
  }
  const echec = (m, c, r) =>
    new ErreurApi(`${m} ${c.split('?')[0]} -> ${r.status}${r.data?.message ? ` (${r.data.message})` : ''}`);
  async function lire(chemin) {
    const r = await requete('GET', chemin);
    if (!r.ok) throw echec('GET', chemin, r);
    return r.data;
  }
  async function ecrire(methode, chemin, corps) {
    const r = await requete(methode, chemin, corps);
    if (!r.ok) throw echec(methode, chemin, r);
    return r.data;
  }
  // Liste paginée ; `cle` si la réponse enveloppe le tableau.
  async function liste(chemin, { cle, pagesMax = 50 } = {}) {
    const sep = chemin.includes('?') ? '&' : '?';
    const tout = [];
    for (let page = 1; page <= pagesMax; page++) {
      const d = await lire(`${chemin}${sep}per_page=100&page=${page}`);
      const items = cle ? d[cle] : d;
      tout.push(...items);
      if (items.length < 100) break;
    }
    return tout;
  }
  return { requete, lire, ecrire, liste };
}

// ---- motifs glob ----
export function motifVersRegex(motif) {
  const ancre = motif.includes('/');
  let re = '';
  for (let i = 0; i < motif.length; i++) {
    const c = motif[i];
    if (c === '*' && motif[i + 1] === '*') {
      if (motif[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(ancre ? `^${re}$` : `(?:^|/)${re}$`, 'i');
}

export function parserMotifs(texte) {
  const motifs = texte.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  if (motifs.length === 0) throw new Error('chemins-sensibles.txt vide : refus de continuer');
  return motifs.map((m) => ({ motif: m, re: motifVersRegex(m) }));
}

export function motifCorrespondant(motifs, chemin) {
  return motifs.find((m) => m.re.test(chemin))?.motif ?? null;
}

const TESTS = [
  /(^|\/)[^/]+\.(test|spec|e2e)\.[^/]+$/i,
  /(^|\/)(__tests__|tests?|e2e|cypress|playwright)\//i,
];
export const estFichierTest = (chemin) => TESTS.some((re) => re.test(chemin));

// Un nom de fichier vient de la PR : ni crochets ni retour à la ligne dans les raisons.
const nomSur = (c) => String(c).replace(/[\[\]\r\n]/g, '?');

// fichiers : tableau de l'API (filename, status, previous_filename).
export function analyserFichiers(fichiers, motifs) {
  const raisons = [];
  for (const f of fichiers) {
    const chemins = [f.filename, f.previous_filename].filter(Boolean);
    for (const c of chemins) {
      const m = motifCorrespondant(motifs, c);
      if (m) raisons.push(`${nomSur(c)} correspond à ${m}`);
    }
    if (f.status === 'removed' && estFichierTest(f.filename)) raisons.push(`test supprimé : ${nomSur(f.filename)}`);
    if (f.status === 'renamed' && f.previous_filename && estFichierTest(f.previous_filename))
      raisons.push(`test renommé : ${nomSur(f.previous_filename)}`);
  }
  return [...new Set(raisons)];
}

// ---- CI ----
// 'ok' | 'attente' | 'rouge' | 'absente'
export function etatRun(run) {
  if (!run) return 'absente';
  if (run.status !== 'completed') return 'attente';
  return run.conclusion === 'success' ? 'ok' : 'rouge';
}
const CHEMIN_CI = '.github/workflows/ci.yml';
const plusRecent = (runs) =>
  [...runs].sort((a, b) => (Date.parse(b.created_at) || 0) - (Date.parse(a.created_at) || 0) || (b.id ?? 0) - (a.id ?? 0))[0];
const memeDepot = (x, o, r) => String(x?.full_name ?? '').toLowerCase() === `${o}/${r}`.toLowerCase();
// Run de ci.yml de la PR n à H : event=pull_request, même dépôt (pas de fork), lié à la PR. Le plus récent.
export async function etatCiAuSha(api, o, r, sha, n) {
  const d = await api.lire(`/repos/${o}/${r}/actions/workflows/ci.yml/runs?head_sha=${sha}&event=pull_request&per_page=100`);
  const valides = (d.workflow_runs ?? []).filter((x) =>
    x.event === 'pull_request' && x.head_sha === sha && x.path === CHEMIN_CI &&
    memeDepot(x.repository, o, r) && memeDepot(x.head_repository, o, r) &&
    (x.pull_requests ?? []).some((p) => p.number === n));
  return etatRun(plusRecent(valides));
}
// Dernier run de ci.yml sur main : event=push, même chemin, même dépôt.
export async function etatCiMain(api, o, r) {
  const d = await api.lire(`/repos/${o}/${r}/actions/workflows/ci.yml/runs?branch=main&event=push&per_page=100`);
  const valides = (d.workflow_runs ?? []).filter((x) =>
    x.event === 'push' && x.path === CHEMIN_CI && memeDepot(x.repository, o, r) && (x.head_branch ?? 'main') === 'main');
  return etatRun(plusRecent(valides));
}

// ---- compare : fichiers fixés sur un commit, jamais « la tête du moment » ----
const REF = /^(?:[0-9a-f]{40}|main)$/;
export async function comparer(api, o, r, base, tete, { fichiers = true } = {}) {
  if (!REF.test(base) || !/^[0-9a-f]{40}$/.test(tete)) throw new Error('compare : références invalides');
  const chemin = `/repos/${o}/${r}/compare/${base}...${tete}`;
  const taille = fichiers ? 100 : 1;
  let premier = null;
  const tous = [];
  let illisible = false;
  for (let page = 1; page <= 4; page++) {
    const d = await api.lire(`${chemin}?per_page=${taille}&page=${page}`);
    premier ??= d;
    if (!fichiers) break;
    if (!Array.isArray(d.files)) { illisible = true; break; }
    const f = d.files;
    tous.push(...f);
    if (f.length < taille || tous.length >= MAX_COMPARE) break;
  }
  return { behind_by: premier.behind_by, ahead_by: premier.ahead_by, fichiers: tous,
    // Fail-closed : tronqué, files absent, ou des commits d'avance sans aucun fichier = on ne sait pas.
    trop: fichiers && (illisible || tous.length >= MAX_COMPARE || (!(premier.ahead_by === 0) && tous.length === 0)) };
}

// ---- protection de main ----
export async function verifierProtection(api, o, r, appId) {
  const res = await api.requete('GET', `/repos/${o}/${r}/branches/main/protection`);
  if (res.status === 404) return ['main n\'a aucune protection'];
  if (!res.ok) throw new Error(`lecture de la protection de main : ${res.status}`);
  const p = res.data;
  const problemes = [];
  const controles = p.required_status_checks?.checks ?? [];
  if (!controles.some((c) => c.context === 'portier' && String(c.app_id) === String(appId)))
    problemes.push(`main n'exige pas le contrôle « portier » lié à l'application ${appId}`);
  if (!p.enforce_admins?.enabled) problemes.push('enforce_admins n\'est pas activé');
  if (p.allow_force_pushes?.enabled !== false) problemes.push('les force-push ne sont pas explicitement interdits');
  if (p.allow_deletions?.enabled !== false) problemes.push('la suppression de main n\'est pas explicitement interdite');
  // Rulesets effectifs sur main : un ruleset avec bypass (ou illisible) = alerte.
  const rg = await api.requete('GET', `/repos/${o}/${r}/rules/branches/main`);
  if (!rg.ok && rg.status !== 404) throw new Error(`lecture des règles de main : ${rg.status}`);
  const ids = new Map();
  for (const x of rg.ok && Array.isArray(rg.data) ? rg.data : []) ids.set(`${x.ruleset_source_type}:${x.ruleset_id}`, x);
  for (const x of ids.values()) {
    const chemin = x.ruleset_source_type === 'Organization'
      ? `/orgs/${o}/rulesets/${x.ruleset_id}` : `/repos/${o}/${r}/rulesets/${x.ruleset_id}`;
    const rs = await api.requete('GET', chemin);
    if (!rs.ok) problemes.push(`ruleset ${x.ruleset_id} illisible (${rs.status})`);
    else if ((rs.data?.bypass_actors ?? []).length > 0) problemes.push(`le ruleset ${x.ruleset_id} autorise des contournements (bypass)`);
  }
  return problemes;
}

// ---- contrôle « portier » ----
export async function controlesPortier(api, o, r, sha, appId) {
  const d = await api.lire(`/repos/${o}/${r}/commits/${sha}/check-runs?check_name=portier&per_page=100`);
  return (d.check_runs ?? []).filter((c) => c.name === 'portier' && String(c.app?.id) === String(appId));
}

export async function poserSucces(api, o, r, sha, appId, resume) {
  const sortie = { title: 'portier : feu vert', summary: resume };
  const existant = (await controlesPortier(api, o, r, sha, appId)).find((c) => c.status !== 'completed');
  if (existant) {
    await api.ecrire('PATCH', `/repos/${o}/${r}/check-runs/${existant.id}`, {
      status: 'completed', conclusion: 'success', output: sortie,
    });
  } else {
    await api.ecrire('POST', `/repos/${o}/${r}/check-runs`, {
      name: 'portier', head_sha: sha, status: 'completed', conclusion: 'success', output: sortie,
    });
  }
}

// Relit la PR : ouverte et toujours à la tête sha ?
export async function teteInchangee(api, o, r, n, sha) {
  const pr = await api.lire(`/repos/${o}/${r}/pulls/${n}`);
  return pr.state === 'open' && pr.head?.sha === sha;
}

// Relit la PR juste avant la fusion, puis fusionne avec sha. Renvoie { fusionne, raison }.
export async function fusionnerSiTeteInchangee(api, o, r, n, sha) {
  const pr = await api.lire(`/repos/${o}/${r}/pulls/${n}`);
  if (pr.state !== 'open' || pr.head?.sha !== sha) return { fusionne: false, raison: 'la tête a changé avant la fusion' };
  const res = await api.requete('PUT', `/repos/${o}/${r}/pulls/${n}/merge`, { sha, merge_method: 'merge' });
  if (res.ok) return { fusionne: true };
  return { fusionne: false, raison: `fusion refusée (${res.status}${res.data?.message ? ` : ${res.data.message}` : ''})` };
}
