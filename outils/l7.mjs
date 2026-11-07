#!/usr/bin/env node
// Lanceur des workflows essai.yml et liberer.yml. Les entrées arrivent par variables
// d'environnement (jamais par la ligne de commande). Journal PUBLIC : codes fixes seulement,
// jamais le message d'une exception.
import { readFileSync, appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { creerClient, masquer, verifierSha } from '../src/coolify.mjs';
import { choisirOutil, synchroniserEssai, verifierEssai, liberer, resumeChangements } from '../src/production.mjs';
import { ErreurGithub, verifierArret, verifierEnvironnementProduction, estAncetreDeMain } from '../src/garde.mjs';

export function codeErreur(e) {
  const c = e?.code;
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{2,60}$/.test(c) ? c : 'ERREUR_INTERNE';
}

function lireJson(texte) {
  try { const o = JSON.parse(texte || '{}'); return o && typeof o === 'object' && !Array.isArray(o) ? o : {}; } catch { return {}; }
}

// Les URL de sonde ne sont pas dans le dépôt (public) : elles viennent de secrets {"nom-de-l-outil": "https://…"}.
export function appliquerSondes(outil, env) {
  const sondes = { essai: lireJson(env.SONDES_ESSAI), production: lireJson(env.SONDES_PRODUCTION) };
  const r = { ...outil };
  for (const cible of ['essai', 'production']) {
    if (!outil[cible]) continue;
    const u = Object.hasOwn(sondes[cible], outil.nom) ? sondes[cible][outil.nom] : undefined;
    r[cible] = { ...outil[cible], sonde: typeof u === 'string' ? u : undefined };
  }
  return r;
}

export async function executer(cmd, env, deps = {}) {
  const f = deps.fetch ?? globalThis.fetch;
  const config = deps.config ?? JSON.parse(readFileSync(new URL('../coolify/outils.json', import.meta.url), 'utf8'));
  const resume = deps.resume ?? ((t) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, t));
  const secrets = [env.COOLIFY_URL_ESSAI, env.COOLIFY_JETON_ESSAI, env.COOLIFY_URL_PRODUCTION, env.COOLIFY_JETON_PRODUCTION, env.SONDES_ESSAI, env.SONDES_PRODUCTION,
    ...Object.values(lireJson(env.SONDES_ESSAI)), ...Object.values(lireJson(env.SONDES_PRODUCTION))].filter((x) => typeof x === 'string');
  const dire = deps.dire ?? ((m) => console.log(masquer(m, secrets)));

  const client = (cible) => {
    const C = cible.toUpperCase();
    return creerClient({ url: env[`COOLIFY_URL_${C}`], jeton: env[`COOLIFY_JETON_${C}`], fetch: f });
  };
  async function gh(chemin) {
    let r;
    try {
      r = await f('https://api.github.com' + chemin, {
        headers: { Accept: 'application/vnd.github+json', ...(env.GH_TOKEN ? { Authorization: `Bearer ${env.GH_TOKEN}` } : {}) },
        signal: AbortSignal.timeout(15000),
      });
    } catch { throw new ErreurGithub('RESEAU'); }
    if (!r.ok) throw new ErreurGithub(r.status);
    return r.json();
  }

  if (cmd === 'essai') {
    // SHA sans OUTIL : refusé. OUTIL (optionnel) ; sinon tous les outils, SHA = tête de main.
    const arretEssai = verifierArret(env.ARRET);
    if (!arretEssai.ok) { dire(arretEssai.code); return 1; }
    if (env.SHA && !env.OUTIL) { dire('SHA_SANS_OUTIL'); return 2; }
    if (env.SHA) { try { verifierSha(env.SHA); } catch { dire('SHA_INVALIDE'); return 2; } }
    const noms = env.OUTIL ? [env.OUTIL] : Object.keys(config.outils ?? {});
    let ko = 0;
    for (const nom of noms) {
      const outil = appliquerSondes(choisirOutil(config, nom), env);
      if (!outil.essai?.uuid) {
        dire(`[${nom}] ESSAI_NON_CONFIGURE`);
        if (env.OUTIL) ko++; // outil demandé explicitement sans essai : échec visible
        continue;
      }
      let sha = env.SHA;
      if (sha) {
        if (!(await estAncetreDeMain(gh, outil.depot, sha))) { dire(`[${nom}] FILIATION_KO`); ko++; continue; }
      } else {
        sha = (await gh(`/repos/${outil.depot}/commits/main`)).sha;
      }
      const r = await synchroniserEssai({ client: client('essai'), f, outil, sha, journal: (c) => dire(`[${nom}] ${c}`) });
      if (!r.ok) ko++;
    }
    return ko ? 1 : 0;
  }

  const outil = appliquerSondes(choisirOutil(config, env.OUTIL), env);
  const sha = env.SHA;
  verifierSha(sha);

  if (cmd === 'verifier-essai') {
    if (env.DEPUIS) { try { verifierSha(env.DEPUIS); } catch { dire('DEPUIS_INVALIDE'); return 1; } }
    const arret = verifierArret(env.ARRET);
    if (!arret.ok) { dire(arret.code); return 1; }
    const garde = await verifierEnvironnementProduction(gh, env.GITHUB_REPOSITORY);
    dire(`ENVIRONNEMENT_PRODUCTION ${garde.code}`);
    if (!garde.ok) return 1;
    const filiation = await estAncetreDeMain(gh, outil.depot, sha);
    dire(`FILIATION ${filiation ? 'OK' : 'KO'}`);
    if (!filiation) return 1;
    const v = await verifierEssai({ client: client('essai'), f, outil, sha });
    dire(`ESSAI ${v.code}`);
    if (!v.ok) return 1;
    let commits = [];
    try {
      commits = env.DEPUIS
        ? (await gh(`/repos/${outil.depot}/compare/${env.DEPUIS}...${sha}`)).commits
        : (await gh(`/repos/${outil.depot}/commits?sha=${sha}&per_page=20`));
      commits = commits.map((c) => ({ sha: c.sha, message: c.commit.message }));
    } catch { dire('RESUME_PARTIEL'); }
    resume(resumeChangements({ outil: outil.nom, sha, commits, depuis: env.DEPUIS, filiation, baseDeclaree: Boolean(outil.production?.db_uuid) }));
    return 0;
  }
  if (cmd === 'liberer') {
    const arret = verifierArret(env.ARRET);
    if (!arret.ok) { dire(arret.code); return 1; }
    const r = await liberer({ client: client('production'), f, outil, sha, journal: (x) => dire(x) });
    resume(`### Résultat : ${r.ok ? 'en production' : 'ÉCHEC'} (${r.code})${r.retourArriere ? ` — retour arrière ${r.retourArriereOk ? 'réussi' : 'ÉCHOUÉ'}` : ''}\n`
      + (r.sansBase ? '- Pas de base de données déclarée : aucune sauvegarde de base n\'a été faite.\n' : ''));
    return r.ok ? 0 : 1;
  }
  dire('COMMANDE_INCONNUE');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  executer(process.argv[2], process.env).then(
    (c) => { process.exitCode = c; },
    (e) => { console.log(codeErreur(e)); process.exitCode = 1; },
  );
}
