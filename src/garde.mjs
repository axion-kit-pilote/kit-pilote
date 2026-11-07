// Gardes de la mise en production (L7). `gh(chemin)` est injecté : il renvoie le JSON ou lève ErreurGithub.
export const RELECTEUR_ID = 221344552;

export class ErreurGithub extends Error {
  constructor(statut) {
    super(`GitHub ${statut}`);
    this.name = 'ErreurGithub';
    this.code = `ERREUR_GITHUB_${statut}`;
  }
}

const DEPOT = /^[\w.-]+\/[\w.-]+$/;

// Interrupteur d'arrêt : la variable ARRET vaut « oui ».
export function verifierArret(valeur) {
  if (String(valeur ?? '').trim().toLowerCase() === 'oui') return { ok: false, code: 'ARRET' };
  return { ok: true, code: 'OK' };
}

// L'environnement « production » du pilote doit avoir Will pour seul relecteur et être limité à main.
export async function verifierEnvironnementProduction(gh, pilote) {
  if (!DEPOT.test(pilote ?? '')) return { ok: false, code: 'PILOTE_INCONNU' };
  const e = await gh(`/repos/${pilote}/environments/production`);
  const regles = Array.isArray(e?.protection_rules) ? e.protection_rules : [];
  const relecteurs = regles.filter((r) => r?.type === 'required_reviewers').flatMap((r) => (Array.isArray(r.reviewers) ? r.reviewers : []));
  if (!relecteurs.length || !relecteurs.every((x) => x?.type === 'User' && x?.reviewer?.id === RELECTEUR_ID)) {
    return { ok: false, code: 'ENV_RELECTEUR_INCORRECT' };
  }
  if (e?.can_admins_bypass !== false) return { ok: false, code: 'ENV_CONTOURNEMENT_ADMIN' };
  const p = e?.deployment_branch_policy;
  if (!p || p.custom_branch_policies !== true || p.protected_branches !== false) return { ok: false, code: 'ENV_BRANCHES_NON_LIMITEES' };
  const l = await gh(`/repos/${pilote}/environments/production/deployment-branch-policies`);
  const pol = Array.isArray(l?.branch_policies) ? l.branch_policies : [];
  if (pol.length !== 1 || pol[0]?.name !== 'main' || (pol[0].type && pol[0].type !== 'branch')) return { ok: false, code: 'ENV_BRANCHES_NON_LIMITEES' };
  return { ok: true, code: 'OK' };
}

// Le SHA doit être un ancêtre de main (ou main lui-même) dans le dépôt de l'outil.
export async function estAncetreDeMain(gh, depot, sha) {
  if (!DEPOT.test(depot ?? '')) return false;
  const cmp = await gh(`/repos/${depot}/compare/${sha}...main`);
  return ['ahead', 'identical'].includes(cmp?.status) && cmp?.merge_base_commit?.sha === sha;
}
