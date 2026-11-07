// Client GitHub et alertes communs à la sonde, à la surveillance et au résumé (L6).
// Aucune dépendance. Les jetons ne sont jamais écrits dans le journal.
export const ORG = 'axion-kit';
export const ORG_PILOTE = 'axion-kit-pilote';
export const PILOTE_PAR_DEFAUT = 'axion-kit-pilote/kit-pilote';
export const SUJET = 'kit-projet';
export const PREFIXE_ALERTE = 'ALERTE';
export const arretDemande = (v) => String(v ?? '').trim().toLowerCase() === 'oui';

export function creerApi({ token, fetchImpl = fetch, base = 'https://api.github.com' }) {
  if (!token) throw new Error('jeton absent');
  async function requete(methode, chemin, corps) {
    const res = await fetchImpl(base + chemin, {
      method: methode,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'kit-sonde',
        ...(corps ? { 'Content-Type': 'application/json' } : {}),
      },
      body: corps ? JSON.stringify(corps) : undefined,
    });
    const texte = await res.text();
    let data = null;
    if (texte) { try { data = JSON.parse(texte); } catch { data = texte; } }
    return { status: res.status, ok: res.ok, data };
  }
  async function lire(chemin) {
    const r = await requete('GET', chemin);
    if (!r.ok) throw new Error(`GET ${chemin.split('?')[0]} -> ${r.status}`);
    return r.data;
  }
  async function liste(chemin, { cle, pagesMax = 50 } = {}) {
    const sep = chemin.includes('?') ? '&' : '?';
    const tout = [];
    for (let page = 1; page <= pagesMax; page++) {
      const d = await lire(`${chemin}${sep}per_page=100&page=${page}`);
      const items = cle ? d[cle] : d;
      tout.push(...items);
      if (items.length < 100) return tout;
    }
    // Liste trop longue : une liste tronquée ferait croire à tort qu'un élément n'existe pas.
    throw new Error(`${chemin.split('?')[0]} : plus de ${pagesMax * 100} éléments (pagesMax atteint), liste incomplète`);
  }
  return { requete, lire, liste };
}

// Issues d'alerte : toujours écrites dans le dépôt pilote avec son propre jeton.
// Une alerte ouverte portant le même titre n'est jamais dupliquée.
// Seules les issues ouvertes par le robot comptent (le dépôt pilote est public).
export const estRobot = (i) => i.user?.login === 'github-actions[bot]' && !i.pull_request;

export async function alerter(apiPilote, pilote, titre, lignes) {
  const t = `${PREFIXE_ALERTE} : ${titre}`;
  // creator=robot : des milliers d'issues tierces (dépôt public) ne peuvent ni noyer ni empêcher l'alerte.
  const ouvertes = await apiPilote.liste(`/repos/${pilote}/issues?state=open&creator=github-actions%5Bbot%5D`);
  if (ouvertes.some((i) => estRobot(i) && i.title === t)) return false;
  const r = await apiPilote.requete('POST', `/repos/${pilote}/issues`, {
    title: t, body: `${lignes.map((l) => `- ${l}`).join('\n')}\n`,
  });
  if (!r.ok) throw new Error(`création de l'alerte -> ${r.status}`);
  return true;
}
