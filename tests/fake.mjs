// Faux GitHub en mémoire : aucun réseau. fetch(url, init) -> Response.
export const APP = '4242';
export const JETON_APP = 'jeton-app';       // jeton d'application : propriétaire axion-kit
export const JETON_PILOTE = 'jeton-pilote'; // github.token de axion-kit-pilote/kit-pilote
export const PILOTE = 'axion-kit-pilote/kit-pilote';
export const sha = (c) => c.repeat(40).slice(0, 40);

export function creerDepot(nom, opts = {}) {
  return {
    name: nom, topics: ['kit-projet'], archived: false,
    protection: {
      required_status_checks: { checks: [{ context: 'portier', app_id: Number(APP) }] },
      enforce_admins: { enabled: true },
      allow_force_pushes: { enabled: false },
      allow_deletions: { enabled: false },
    },
    rules: [], rulesets: {}, mainCi: 'success', ci: {}, pulls: {}, checks: [], merges: [], ...opts,
  };
}
// PR du même dépôt, tête H, CI verte par défaut.
// ci : 'success' | 'failure' | 'attente' | null | tableau de runs (surcharges : etat, event, path, …).
// fichiersFiles : ce que renverrait /pulls/n/files (la tête « du moment »), distinct du compare.
export function ajouterPr(d, n, { head = sha('a'), fichiers = [{ filename: 'src/app.js', status: 'modified' }], fork = false, ci = 'success', changed, fichiersFiles, retard = 0, sansSha = false, sansFiles = false } = {}) {
  d.pulls[n] = { number: n, state: 'open', draft: false, base: { ref: 'main' }, tetes: [head], toutesTetes: [head], reelle: head, fork, fichiers, fichiersFiles: fichiersFiles ?? fichiers, changed, retard, sansSha, sansFiles };
  d.ci[head] = ci;
}

export function creerFake({ depots, pilote = PILOTE }) {
  const etat = { depots: Object.fromEntries(depots.map((d) => [d.name, d])), dispatches: [], marqueurs: [], dispatchEchec: false, issues: [], appels: [], idCheck: 1, idRun: 0, rulesetsOrg: {} };
  const json = (d, s = 200) => new Response(JSON.stringify(d), { status: s });
  const pagine = (liste, q) => { const pp = +q.get('per_page') || 30, p = +q.get('page') || 1; return liste.slice((p - 1) * pp, p * pp); };
  const etatVers = (v) => (v === 'attente' ? { status: 'in_progress', conclusion: null } : { status: 'completed', conclusion: v });
  const runsDe = (d, valeur, extraBase) => {
    if (!valeur) return { workflow_runs: [] };
    const liste = Array.isArray(valeur) ? valeur : [{ etat: valeur }];
    return {
      workflow_runs: liste.map(({ etat: e = 'success', ...surcharge }) => {
        const id = ++etat.idRun;
        return {
          id, ...etatVers(e), event: 'pull_request', path: '.github/workflows/ci.yml',
          repository: { full_name: `axion-kit/${d.name}` }, head_repository: { full_name: `axion-kit/${d.name}` },
          created_at: new Date(1e12 + id * 1000).toISOString(), ...extraBase, ...surcharge,
        };
      }),
    };
  };
  const prVue = (d, p, avance) => {
    const head = p.tetes.length > 1 && avance ? p.tetes.shift() : p.tetes[0];
    const nom = p.fork ? 'autre/fork' : `axion-kit/${d.name}`;
    return { number: p.number, state: p.state, draft: p.draft, base: { ref: p.base.ref, sha: sha('0') }, head: { ...(p.sansSha ? {} : { sha: head }), repo: { full_name: nom } }, changed_files: p.changed ?? p.fichiers.length };
  };

  async function fetchFake(url, init = {}) {
    const u = new URL(url); const q = u.searchParams; const m = init.method ?? 'GET';
    const corps = init.body ? JSON.parse(init.body) : null;
    const jeton = String(init.headers?.Authorization ?? '').replace(/^Bearer /, '');
    etat.appels.push(`${m} ${u.pathname}`);
    // Jetons : l'application (propriétaire axion-kit) ne peut rien écrire dans axion-kit-pilote.
    if (u.pathname.startsWith('/repos/axion-kit-pilote/') && jeton !== JETON_PILOTE) return json({ message: 'Resource not accessible by integration' }, 403);
    if (/^\/(repos|orgs)\/axion-kit\//.test(u.pathname) && m !== 'GET' && jeton !== JETON_APP) return json({ message: 'Resource not accessible by integration' }, 403);
    let r;
    if (m === 'GET' && u.pathname === '/orgs/axion-kit/repos') return json(pagine(Object.values(etat.depots).map((d) => ({ name: d.name, topics: d.topics, archived: d.archived })), q));
    if ((r = /^\/orgs\/axion-kit\/rulesets\/(\d+)$/.exec(u.pathname))) return etat.rulesetsOrg[r[1]] ? json(etat.rulesetsOrg[r[1]]) : json({ message: 'Not Found' }, 404);
    if (m === 'GET' && u.pathname === `/repos/${pilote}/issues`) return json(pagine(etat.issues, q));
    if (m === 'POST' && u.pathname === `/repos/${pilote}/issues`) { etat.issues.push({ ...corps, number: etat.issues.length + 1 }); return json({}, 201); }
    if (m === 'POST' && u.pathname === `/repos/${pilote}/actions/workflows/porte.yml/dispatches`) {
      const dd = etat.depots[corps.inputs.repo.split('/')[1]];
      etat.marqueurs.push(dd.checks.some((c) => c.head_sha === corps.inputs.sha && c.external_id === `dispatch:${corps.inputs.sha}`));
      if (etat.dispatchEchec) return json({ message: 'boom' }, 500);
      etat.dispatches.push(corps); return new Response(null, { status: 204 });
    }
    if (!(r = /^\/repos\/axion-kit\/([^/]+)(\/.*)?$/.exec(u.pathname))) return json({ message: 'inconnu' }, 404);
    const d = etat.depots[r[1]]; const rest = r[2] ?? ''; let x;
    if (!d) return json({ message: 'dépôt inconnu' }, 404);
    if (rest === '' && m === 'GET') return json({ name: d.name, topics: d.topics, archived: d.archived });
    if (rest === '/branches/main/protection') return d.protection ? json(d.protection) : json({ message: 'Not Found' }, 404);
    if (rest === '/rules/branches/main') return json(d.rules);
    if ((x = /^\/rulesets\/(\d+)$/.exec(rest))) return d.rulesets[x[1]] ? json(d.rulesets[x[1]]) : json({ message: 'Not Found' }, 404);
    if (rest === '/actions/workflows/ci.yml/runs') {
      const h = q.get('head_sha');
      if (h) {
        const prs = Object.values(d.pulls).filter((p) => p.toutesTetes.includes(h)).map((p) => ({ number: p.number }));
        return json(runsDe(d, d.ci[h], { head_sha: h, pull_requests: prs }));
      }
      return json(runsDe(d, d.mainCi, { event: 'push', head_branch: 'main', head_sha: sha('9'), pull_requests: [] }));
    }
    if ((x = /^\/compare\/([0-9a-f]{40}|main)\.\.\.([0-9a-f]{40})$/.exec(rest))) {
      const p = Object.values(d.pulls).find((pp) => pp.toutesTetes.includes(x[2]));
      if (!p) return json({ message: 'Not Found' }, 404);
      return json({ status: 'ahead', ahead_by: 1, behind_by: p.retard, ...(p.sansFiles ? {} : { files: pagine(p.fichiers, q) }) });
    }
    if (m === 'GET' && rest === '/pulls') return json(pagine(Object.values(d.pulls).map((p) => prVue(d, p, false)), q));
    if ((x = /^\/pulls\/(\d+)$/.exec(rest)) && m === 'GET') return json(prVue(d, d.pulls[x[1]], true));
    if ((x = /^\/pulls\/(\d+)\/files$/.exec(rest))) return json(pagine(d.pulls[x[1]].fichiersFiles, q));
    if ((x = /^\/pulls\/(\d+)\/merge$/.exec(rest)) && m === 'PUT') {
      const p = d.pulls[x[1]];
      if (corps.sha !== p.reelle) return json({ message: 'Head branch was modified' }, 409);
      d.merges.push({ pr: p.number, ...corps }); p.state = 'closed'; return json({ merged: true });
    }
    if ((x = /^\/commits\/([0-9a-f]+)\/check-runs$/.exec(rest))) return json({ check_runs: d.checks.filter((c) => c.head_sha === x[1] && c.name === q.get('check_name')) });
    if (m === 'POST' && rest === '/check-runs') { const c = { ...corps, id: etat.idCheck++, app: { id: Number(APP) }, status: corps.status }; d.checks.push(c); return json(c, 201); }
    if ((x = /^\/check-runs\/(\d+)$/.exec(rest)) && m === 'PATCH') { Object.assign(d.checks.find((c) => c.id === +x[1]), corps); return json({}); }
    return json({ message: `route non simulée : ${m} ${u.pathname}` }, 404);
  }
  return { etat, fetch: fetchFake };
}
