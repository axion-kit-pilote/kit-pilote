#!/usr/bin/env node
// Usage : node outils/kit-nouveau.mjs <nom> "<description>" [app_id]
// À lancer en local chez Will (gh connecté). app_id : argument ou variable PORTIER_APP_ID.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ORG = 'axion-kit';
const RESERVES = new Set(['kit-modele', 'kit-pilote', 'kit-pilote-source']);

export function validerNom(nom) {
  if (typeof nom !== 'string' || !/^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/.test(nom) || nom.includes('--'))
    throw new Error(`nom invalide « ${nom} » : minuscules, chiffres et tirets, 3 à 40 caractères`);
  if (RESERVES.has(nom)) throw new Error(`nom réservé : ${nom}`);
  return nom;
}
export function validerDescription(d) {
  if (typeof d !== 'string' || !d.trim() || d.length > 350 || /[\x00-\x08\x0b-\x1f]/.test(d))
    throw new Error('description vide, trop longue (> 350) ou avec des caractères de contrôle');
  return d.trim();
}
export function validerAppId(id) {
  if (!/^\d+$/.test(id ?? '')) throw new Error('app_id manquant ou invalide (argument ou variable PORTIER_APP_ID)');
  return Number(id);
}
export function corpsProtectionEtat() {
  return { required_status_checks: null, enforce_admins: true, required_pull_request_reviews: null, restrictions: null, allow_force_pushes: false, allow_deletions: false };
}

export function corpsProtection(appId) {
  return {
    required_status_checks: {
      strict: false,
      checks: [{ context: 'portier', app_id: appId }], // seul « portier » : un contrôle « ci » est falsifiable
    },
    enforce_admins: true,
    required_pull_request_reviews: null,
    restrictions: null,
    allow_force_pushes: false,
    allow_deletions: false,
  };
}

const ghReel = (...args) => execFileSync('gh', args, { encoding: 'utf8' }).trim();
const ghJsonReel = (args, corps) =>
  execFileSync('gh', ['api', ...args, '--input', '-'], { input: JSON.stringify(corps), encoding: 'utf8' });
const defaut = (ms) => new Promise((r) => setTimeout(r, ms));

export async function creer(nom, description, appId, { log = console.log, gh = ghReel, ghJson = ghJsonReel, pause = defaut } = {}) {
  const depot = `${ORG}/${nom}`;
  log(`Création de ${depot}…`);
  gh('repo', 'create', depot, '--public', '--template', `${ORG}/kit-modele`, '--description', description);

  // Ordre voulu : protection de main AVANT le sujet kit-projet (le portier n'agit qu'après) et avant la branche etat.
  let sha = '';
  for (let i = 0; i < 10 && !sha; i++) {
    try { sha = gh('api', `repos/${depot}/git/ref/heads/main`, '--jq', '.object.sha'); } catch { await pause(3000); }
  }
  if (!sha) throw new Error('main introuvable après la création (réessayer plus tard)');
  ghJson(['-X', 'PUT', `repos/${depot}/branches/main/protection`], corpsProtection(appId));
  gh('repo', 'edit', depot, '--add-topic', 'kit-projet');

  // Branche « etat » : SPEC.md + REPRENDRE.md (ETAT: TRAVAIL), créée depuis main.
  ghJson(['-X', 'POST', `repos/${depot}/git/refs`], { ref: 'refs/heads/etat', sha });
  const ecrire = (chemin, contenu, message) => {
    let ancien;
    try { ancien = gh('api', `repos/${depot}/contents/${chemin}?ref=etat`, '--jq', '.sha'); } catch { /* absent */ }
    ghJson(['-X', 'PUT', `repos/${depot}/contents/${chemin}`], {
      message, branch: 'etat', content: Buffer.from(contenu).toString('base64'), ...(ancien ? { sha: ancien } : {}),
    });
  };
  ecrire('SPEC.md', `# ${nom}\n\n${description}\n`, 'SPEC : description initiale');
  ecrire('REPRENDRE.md', `# REPRENDRE\n\nETAT: TRAVAIL\n\nRien de fait. Lire SPEC.md.\n`, 'REPRENDRE : ETAT TRAVAIL');
  // etat : ni suppression ni force-push (essai E8-mini : la suppression passait).
  ghJson(['-X', 'PUT', `repos/${depot}/branches/etat/protection`], corpsProtectionEtat());

  ghJson(['-X', 'PATCH', `repos/${depot}`], {
    security_and_analysis: {
      secret_scanning: { status: 'enabled' },
      secret_scanning_push_protection: { status: 'enabled' },
    },
  });
  log(`${depot} prêt : sujet kit-projet, branche etat, protection de main et de etat, push protection.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const [, , nom, description, id] = process.argv;
    validerNom(nom);
    const d = validerDescription(description);
    const appId = validerAppId(id ?? process.env.PORTIER_APP_ID);
    await creer(nom, d, appId);
  } catch (e) {
    console.error(`Refus : ${e.message}\nUsage : node outils/kit-nouveau.mjs <nom> "<description>" [app_id]`);
    process.exitCode = 1;
  }
}
