// Faux Coolify en mémoire : un fetch qui imite les routes utilisées.
export const SHA_A = 'a'.repeat(40);
export const SHA_B = 'b'.repeat(40);
export const SHA_C = 'c'.repeat(40);
export const JETON = 'jeton-secret-1234567890';
export const URL_C = 'https://coolify.exemple.test';

export const SITES = { 'https://essai.demo.test/sante': 'ess1', 'https://demo.test/sante': 'prd1' };

// `sert` = SHA réellement servi par le conteneur en ligne (change seulement après un déploiement réussi).
// `bases` : { db1: { sauvegarde: 'success' | 'failed' | 'jamais' | 'absente' } }
export function fauxCoolify({ apps = {}, deploiementEchoue = (sha) => false, sante = () => true, fuiteJeton = false, sites = SITES, bases = {} } = {}) {
  const appels = [];
  const deploiements = {};
  let n = 0;
  const rep = (status, corps) => ({ ok: status < 400, status, text: async () => (corps === undefined ? '' : JSON.stringify(corps)) });
  const init = (a) => {
    const enLigne = String(a.status ?? '').startsWith('running');
    a.deploiements ??= a.git_commit_sha && enLigne ? [{ deployment_uuid: 'init', status: 'finished', commit: a.git_commit_sha, created_at: 1 }] : [];
    if (a.sert === undefined) a.sert = enLigne ? a.git_commit_sha : null;
    return a;
  };
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    const methode = opts.method ?? 'GET';
    if (u.origin !== URL_C) {
      // sonde de santé
      appels.push({ methode, sonde: u.href });
      const bon = sante(u.href, apps);
      const app = apps[sites[u.href]];
      return { ok: bon, status: bon ? 200 : 503, text: async () => JSON.stringify({ sha: app ? init(app).sert : null }) };
    }
    appels.push({ methode, chemin: u.pathname + u.search, auth: opts.headers?.Authorization, corps: opts.body ? JSON.parse(opts.body) : undefined });
    if (opts.headers?.Authorization !== `Bearer ${JETON}`) return rep(401, { message: 'Unauthenticated.' });
    const p = u.pathname.replace('/api/v1', '');
    let m;
    if (fuiteJeton) return rep(500, { message: `boom ${JETON} ${URL_C}` });
    if (p === '/applications/public' && methode === 'POST') { apps['nouvelle'] = { git_commit_sha: JSON.parse(opts.body).git_commit_sha, status: 'exited' }; return rep(201, { uuid: 'nouvelle' }); }
    if ((m = p.match(/^\/databases\/([\w-]+)\/backups(?:\/([\w-]+)\/executions)?$/))) {
      const b = bases[m[1]];
      if (!b || b.sauvegarde === 'absente') return rep(404, { message: 'inconnu' });
      b.executions ??= [];
      if (!m[2]) return rep(200, [{ uuid: 'bk1' }]);
      if (methode === 'POST') {
        if (b.sauvegarde !== 'jamais') b.executions.push({ uuid: 'ex' + (b.executions.length + 1), status: b.sauvegarde });
        b.declenchee = (b.declenchee ?? 0) + 1;
        return rep(201, {});
      }
      return rep(200, b.executions);
    }
    if ((m = p.match(/^\/deployments\/applications\/([\w-]+)$/))) {
      const a = apps[m[1]];
      if (!a) return rep(404, { message: 'Application not found' });
      return rep(200, { count: init(a).deploiements.length, deployments: [...a.deploiements].reverse() });
    }
    if ((m = p.match(/^\/applications\/([\w-]+)$/))) {
      const a = apps[m[1]];
      if (!a) return rep(404, { message: 'Application not found' });
      if (methode === 'PATCH') { Object.assign(a, JSON.parse(opts.body)); return rep(200, { uuid: m[1] }); }
      return rep(200, { uuid: m[1], git_commit_sha: a.git_commit_sha, status: a.status });
    }
    if (p === '/applications/public' && methode === 'POST') { apps['nouvelle'] = { git_commit_sha: JSON.parse(opts.body).git_commit_sha, status: 'exited' }; return rep(201, { uuid: 'nouvelle' }); }
    if (p === '/deploy') {
      const a = init(apps[u.searchParams.get('uuid')]);
      const id = 'dep' + ++n;
      const ko = deploiementEchoue(a.git_commit_sha);
      deploiements[id] = ko ? 'failed' : 'finished';
      a.deploiements.push({ deployment_uuid: id, status: deploiements[id], commit: a.git_commit_sha, created_at: 1000 + n });
      if (!ko) { a.status = 'running:healthy'; a.sert = a.git_commit_sha; }
      return rep(200, { deployments: [{ deployment_uuid: id }] });
    }
    if ((m = p.match(/^\/deployments\/([\w-]+)$/))) return rep(200, { status: deploiements[m[1]] });
    if ((m = p.match(/^\/applications\/([\w-]+)\/envs$/))) {
      const a = apps[m[1]]; a.envs ??= [];
      if (methode === 'GET') return rep(200, a.envs.map((e) => ({ key: e.key, value: e.value })));
      const b = JSON.parse(opts.body);
      const e = a.envs.find((x) => x.key === b.key);
      if (e) e.value = b.value; else a.envs.push(b);
      return rep(201, {});
    }
    return rep(404, { message: 'inconnu' });
  };
  return { f, appels, apps, bases };
}
