// Résumé quotidien (L6) : une issue « Résumé du JJ/MM » dans le dépôt pilote, en français simple.
// Ferme le résumé de la veille. Lecture seule sur axion-kit ; écriture avec le jeton du pilote.
// Les titres de PR et lignes ETAT viennent d'agents : ils sont neutralisés avant d'être recopiés.
import { fileURLToPath } from 'node:url';
import { ORG, PILOTE_PAR_DEFAUT, SUJET, PREFIXE_ALERTE, arretDemande, creerApi, estRobot } from './client6.mjs';

export const PREFIXE_RESUME = 'Résumé du ';
const JOUR = 24 * 3600 * 1000;

export function dateCourte(ms, fuseau = 'Europe/Paris') {
  const p = Object.fromEntries(new Intl.DateTimeFormat('fr-FR', { timeZone: fuseau, day: '2-digit', month: '2-digit' })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}`;
}

// Texte venu d'ailleurs : une seule ligne, pas de lien, pas de mention, pas de balise.
export const propre = (t, max = 90) => {
  const s = String(t ?? '').replace(/[\u0000-\u001f\u007f​-‏‪-‮]/g, ' ')
    .replace(/:\/\//g, ' ').replace(/[`<>\[\]()*_~|#!@\\]/g, '').replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

async function etatReprendre(api, o, r) {
  // La fiche vit sur la branche etat ; main à défaut (seulement si etat n'a pas la fiche).
  let res = await api.requete('GET', `/repos/${o}/${r}/contents/REPRENDRE.md?ref=etat`);
  if (res.status === 404) res = await api.requete('GET', `/repos/${o}/${r}/contents/REPRENDRE.md`);
  if (res.status === 404) return 'pas de fiche de reprise';
  if (!res.ok) return 'fiche de reprise illisible';
  const texte = Buffer.from(res.data?.content ?? '', 'base64').toString('utf8');
  const m = /^ETAT\s*:\s*(.+)$/m.exec(texte);
  return m ? propre(m[1]) || 'état vide' : 'pas de ligne « ETAT »';
}

export async function construire({ api, apiPilote, pilote, appId, arret, maintenant }) {
  const depots = (await api.liste(`/orgs/${ORG}/repos?type=all`)).filter((d) => (d.topics ?? []).includes(SUJET) && !d.archived);
  const fusionnees = []; const attente = []; const etats = []; const lacunes = [];
  for (const d of depots) {
    const r = d.name;
    try {
      const fermees = await api.lire(`/repos/${ORG}/${r}/pulls?state=closed&sort=updated&direction=desc&per_page=50`);
      for (const p of fermees)
        if (p.merged_at && maintenant - Date.parse(p.merged_at) <= JOUR) fusionnees.push(`${propre(r, 40)} : ${propre(p.title)}`);
      for (const p of await api.liste(`/repos/${ORG}/${r}/pulls?state=open`)) {
        const sha = p.head?.sha;
        if (!sha) continue;
        const cr = await api.lire(`/repos/${ORG}/${r}/commits/${sha}/check-runs?check_name=portier&per_page=100`);
        if ((cr.check_runs ?? []).some((c) => c.name === 'portier' && c.status !== 'completed' && String(c.app?.id) === String(appId)))
          attente.push(`${propre(r, 40)} : ${propre(p.title)}`);
      }
      etats.push(`${propre(r, 40)} : ${await etatReprendre(api, ORG, r)}`);
    } catch { lacunes.push(propre(r, 40)); }
  }
  const alertes = (await apiPilote.liste(`/repos/${pilote}/issues?state=open&creator=github-actions%5Bbot%5D`))
    .filter((i) => estRobot(i) && i.title.startsWith(`${PREFIXE_ALERTE} : `))
    .map((i) => propre(i.title.slice(PREFIXE_ALERTE.length + 3), 120));
  const bloc = (titre, lignes, vide) => `## ${titre}\n${lignes.length ? lignes.map((l) => `- ${l}`).join('\n') : vide}\n`;
  const corps = [
    arret ? '**Tout est arrêté.** Rien ne se fait tant que vous n\'avez pas repris (voir docs/ARRET.md).\n' : 'Tout tourne normalement.\n',
    bloc('Ce qui a été accepté depuis hier', fusionnees, 'Rien.'),
    bloc('Ce qui attend votre OK', attente, 'Rien n\'attend.'),
    bloc('Alertes ouvertes', alertes, 'Aucune alerte.'),
    bloc('Où en sont les outils', etats, 'Aucun outil pour le moment.'),
    ...(lacunes.length ? [bloc('Je n\'ai pas pu lire', lacunes, '')] : []),
  ].join('\n');
  return { corps, nombres: { fusionnees: fusionnees.length, attente: attente.length, alertes: alertes.length } };
}

export async function resume({ env = process.env, fetchImpl = fetch, maintenant = Date.now(), log = console.log } = {}) {
  const pilote = env.GITHUB_REPOSITORY || PILOTE_PAR_DEFAUT;
  if (!env.PORTIER_APP_ID) throw new Error('PORTIER_APP_ID absent');
  const api = creerApi({ token: env.GH_TOKEN, fetchImpl });
  const apiPilote = creerApi({ token: env.PILOTE_TOKEN, fetchImpl });
  const { corps, nombres } = await construire({ api, apiPilote, pilote, appId: env.PORTIER_APP_ID, arret: arretDemande(env.ARRET), maintenant });
  const titre = `${PREFIXE_RESUME}${dateCourte(maintenant)}`;
  const ouvertes = await apiPilote.liste(`/repos/${pilote}/issues?state=open&creator=github-actions%5Bbot%5D`);
  const resumes = ouvertes.filter((i) => estRobot(i) && i.title.startsWith(PREFIXE_RESUME));
  const du_jour = resumes.find((i) => i.title === titre);
  const ecrire = async (m, ch, c) => { const r = await apiPilote.requete(m, ch, c); if (!r.ok) throw new Error(`${m} ${ch.split('?')[0]} -> ${r.status}`); };
  if (du_jour) await ecrire('PATCH', `/repos/${pilote}/issues/${du_jour.number}`, { body: corps });
  else await ecrire('POST', `/repos/${pilote}/issues`, { title: titre, body: corps });
  for (const i of resumes.filter((x) => x !== du_jour)) await ecrire('PATCH', `/repos/${pilote}/issues/${i.number}`, { state: 'closed', state_reason: 'completed' });
  log(`${titre} : ${nombres.fusionnees} fusionnée(s), ${nombres.attente} en attente, ${nombres.alertes} alerte(s)`);
  return { titre, corps, ...nombres };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  resume().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
