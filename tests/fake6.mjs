// Faux GitHub en mémoire pour L6 : aucun réseau.
export const APP = '4242';
export const PILOTE = 'axion-kit-pilote/kit-pilote';
export const J_APP = 'jeton-app';
export const J_PILOTE = 'jeton-pilote';
export const J_ARRET = 'jeton-arret';
export const J_ORG = 'jeton-org';
let compteurId = 1000;

export const protectionOk = () => ({
  required_status_checks: { checks: [{ context: 'portier', app_id: Number(APP) }] },
  enforce_admins: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
});
export const depot = (name, o = {}) => ({
  id: ++compteurId, name, topics: ['kit-projet'], archived: false, protection: protectionOk(), rules: [], rulesets: {},
  prs: [], contenus: {}, checks: {}, ...o,
});

export function creerFake({ depots = [], installationsOrg = ['claude', 'kit-portier', 'kit-createur'], installationsPilote = [], runsPortier, issues = [], variables = {}, vivant } = {}) {
  const e = {
    depots: Object.fromEntries(depots.map((d) => [d.name, d])), installationsOrg, installationsPilote,
    runsPortier: runsPortier ?? [{ created_at: new Date().toISOString() }],
    issues: [...issues], variables: { ...variables }, appels: [], urls: [], refus: new Set(), n: 100,
    vivant: vivant === undefined ? `vivant : ${new Date().toISOString()}\n` : vivant,
    workflows: { 'portier.yml': 'active', 'sonde.yml': 'active', 'surveiller.yml': 'active', 'resume-quotidien.yml': 'active', 'reveil.yml': 'active' },
    contenusPilote: {},
  };
  const json = (d, s = 200) => (s === 204 ? new Response(null, { status: 204 }) : new Response(JSON.stringify(d), { status: s }));
  const pag = (l, q) => { const pp = +q.get('per_page') || 30, p = +q.get('page') || 1; return l.slice((p - 1) * pp, p * pp); };
  async function fetchFake(url, init = {}) {
    const u = new URL(url); const q = u.searchParams; const m = init.method ?? 'GET';
    const corps = init.body ? JSON.parse(init.body) : null;
    const jeton = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    e.appels.push(`${m} ${u.pathname}`); e.urls.push(`${m} ${u.pathname}${u.search}`);
    const p = u.pathname; let r;
    if ([...e.refus].some((x) => p.startsWith(x))) return json({ message: 'refusé' }, 403);
    // le jeton de l'application ne touche pas au pilote ; le jeton du pilote ne touche pas axion-kit
    if (p.startsWith('/repos/axion-kit-pilote/') && jeton !== J_PILOTE && jeton !== J_ARRET) return json({ message: 'Resource not accessible by integration' }, 403);
    if (/^\/repos\/axion-kit\//.test(p) && m !== 'GET') return json({ message: 'lecture seule' }, 403);
    if (p === '/orgs/axion-kit/repos') return json(pag(Object.values(e.depots).filter((d) => q.get('type') !== 'public' || !d.private).map((d) => ({ id: d.id, name: d.name, topics: d.topics, archived: d.archived, private: !!d.private })), q));
    if (p === '/orgs/axion-kit-pilote/repos') return json(pag((e.depotsPilote ?? []).filter((n) => q.get('type') === 'public').map((name) => ({ name, topics: [], archived: false, private: false })), q));
    if (p === '/orgs/axion-kit/installations') return json({ total_count: e.installationsOrg.length, installations: e.installationsOrg.map((s) => ({ app_slug: s })) });
    if (p === '/orgs/axion-kit-pilote/installations') return json({ total_count: e.installationsPilote.length, installations: e.installationsPilote.map((s) => ({ app_slug: s })) });
    if ((r = /^\/orgs\/axion-kit\/rulesets\/(\d+)$/.exec(p))) return e.rulesetsOrg?.[r[1]] ? json(e.rulesetsOrg[r[1]]) : json({}, 404);
    if (p === `/repos/${PILOTE}/actions/workflows/portier.yml/runs`) return json({ workflow_runs: e.runsPortier.slice(0, +q.get('per_page') || 30) });
    if ((r = new RegExp(`^/repos/${PILOTE}/actions/workflows/([^/]+)(/enable)?$`).exec(p))) {
      const noms = Object.keys(e.workflows); const nom = r[1] in e.workflows ? r[1] : noms[+r[1] - 11];
      if (!nom) return json({}, 404);
      if (r[2] && m === 'PUT') { if (e.sansDroitActions) return json({}, 403); e.workflows[nom] = 'active'; return new Response(null, { status: 204 }); }
      return json({ id: 11 + noms.indexOf(nom), path: `.github/workflows/${nom}`, state: e.workflows[nom] });
    }
    if (p === `/repos/${PILOTE}` && m === 'GET') return json({ default_branch: 'main' });
    if (p === `/repos/${PILOTE}/git/ref/heads/main`) return json({ object: { sha: 'abc' } });
    if (p === `/repos/${PILOTE}/git/refs` && m === 'POST') { if (e.sansDroitContenu) return json({}, 403); e.brancheVivant = true; return json({}, 201); }
    if (p === `/repos/${PILOTE}/branches/vivant`) return (e.brancheVivant ?? e.vivant != null) ? json({ name: 'vivant' }) : json({}, 404);
    if (p === `/repos/${PILOTE}/contents/vivant.txt` && m === 'PUT') { if (e.sansDroitContenu) return json({}, 403); e.vivant = Buffer.from(corps.content, 'base64').toString(); e.dernierPut = corps; return json({}, 200); }
    if (p === `/repos/${PILOTE}/contents/vivant.txt`) return e.vivant == null ? json({}, 404) : json({ content: Buffer.from(e.vivant).toString('base64'), sha: 'sv' });
    if (p === `/repos/${PILOTE}/issues` && m === 'GET') return json(pag(e.issues.filter((i) => (i.state === (q.get('state') ?? 'open') || q.get('state') === 'all') && (!q.get('creator') || i.user?.login === q.get('creator'))), q));
    if (p === `/repos/${PILOTE}/issues` && m === 'POST') { const i = { ...corps, number: ++e.n, state: 'open', user: { login: 'github-actions[bot]' } }; e.issues.push(i); return json(i, 201); }
    if ((r = new RegExp(`^/repos/${PILOTE}/issues/(\\d+)$`).exec(p)) && m === 'PATCH') { Object.assign(e.issues.find((i) => i.number === +r[1]), corps); return json({}); }
    if (/\/actions\/variables/.test(p) && p.startsWith(`/repos/${PILOTE}`)) {
      if (jeton === J_PILOTE && e.sansDroitVariables) return json({ message: 'Resource not accessible by integration' }, 403);
      if (m === 'GET') { const n = p.split('/').pop(); return n in e.variables ? json({ name: n, value: e.variables[n] }) : json({}, 404); }
      if (m !== 'GET') (e.ecrituresVariables ??= []).push({ nom: corps.name, jeton });
      if (m === 'PATCH') { if (!(corps.name in e.variables)) return json({}, 404); e.variables[corps.name] = corps.value; return json({}, 204); }
      if (m === 'POST') { e.variables[corps.name] = corps.value; return json({}, 201); }
    }
    if (!(r = /^\/repos\/axion-kit\/([^/]+)(\/.*)?$/.exec(p))) return json({ message: `route non simulée ${m} ${p}` }, 404);
    const d = e.depots[r[1]]; const rest = r[2] ?? ''; let x;
    if (!d) return json({}, 404);
    if (rest === '/branches/main/protection') return d.protection ? json(d.protection) : json({}, 404);
    if (rest === '/rules/branches/main') return json(d.rules);
    if (rest === '/branches/etat') return d.etat ? json({ name: 'etat' }) : json({}, 404);
    if (rest === '/branches/etat/protection') return d.etat?.protection ? json(d.etat.protection) : json({}, 404);
    if (rest === '/rules/branches/etat') return json(d.etat?.rules ?? []);
    if (rest === '/rulesets') return json(Object.keys(d.rulesets).map((id) => ({ id: +id })));
    if ((x = /^\/rulesets\/(\d+)$/.exec(rest))) { const rs = d.rulesets[x[1]] ?? (q.get('includes_parents') === 'true' ? e.rulesetsOrg?.[x[1]] : null); return rs ? json(rs) : json({}, 404); }
    if (rest === '/pulls') return json(pag(d.prs.filter((pr) => pr.state === (q.get('state') ?? 'open')), q));
    if ((x = /^\/commits\/([^/]+)\/check-runs$/.exec(rest))) return json({ check_runs: d.checks[x[1]] ?? [] });
    if ((x = /^\/contents\/(.+)$/.exec(rest))) { const c = q.get('ref') === 'etat' ? d.contenusEtat?.[x[1]] : d.contenus[x[1]]; return c == null ? json({}, 404) : json({ content: Buffer.from(c).toString('base64'), encoding: 'base64' }); }
    return json({ message: `route non simulée ${m} ${p}` }, 404);
  }
  return { etat: e, fetch: fetchFake };
}
export const envSonde = (extra = {}) => ({
  GH_TOKEN: J_APP, PILOTE_TOKEN: J_PILOTE, PORTIER_APP_ID: APP, GITHUB_REPOSITORY: PILOTE,
  ORG_TOKEN: J_ORG, ARRET_TOKEN: J_ARRET, ...extra,
});
