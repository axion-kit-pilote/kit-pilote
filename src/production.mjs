// Logique de l'essai et de la libération (L7). Aucun accès direct au réseau :
// tout passe par le client Coolify et un fetch injectés (testables avec un faux Coolify).
import { CoolifyError, verifierSha, masquer } from './coolify.mjs';

export function choisirOutil(config, nom) {
  if (typeof nom !== 'string' || !/^[a-z0-9-]{1,40}$/.test(nom)) throw new CoolifyError('outil inconnu', undefined, 'OUTIL_INCONNU');
  const outils = config?.outils;
  if (!outils || typeof outils !== 'object' || !Object.hasOwn(outils, nom) || !outils[nom] || typeof outils[nom] !== 'object') {
    throw new CoolifyError('outil inconnu', undefined, 'OUTIL_INCONNU');
  }
  return { nom, ...outils[nom] };
}

const HEX40 = /^[0-9a-f]{40}$/;

// Sonde de santé : HTTP 200 ET le corps JSON annonce le SHA attendu ({"sha": "…"}), quelques essais.
// Un ancien conteneur encore en ligne répond 200 mais avec un autre SHA : refusé.
export async function sonde(f, url, sha, { essais = 5, sleep, delaiMs = 5000 } = {}) {
  const attendre = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  if (!url || !HEX40.test(sha ?? '')) return false;
  try { if (new URL(url).protocol !== 'https:') return false; } catch { return false; }
  for (let i = 0; i < essais; i++) {
    try {
      const r = await f(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      if (r.status === 200) {
        const corps = JSON.parse(await r.text());
        if (corps && corps.sha === sha) return true;
      }
    } catch { /* on réessaie */ }
    if (i < essais - 1) await attendre(delaiMs);
  }
  return false;
}

// Ce qui tourne VRAIMENT : le dernier déploiement terminé avec succès porte ce SHA ET la sonde le confirme.
async function verifierReel({ client, f, cible, sha, sleep, essais }) {
  const d = await client.dernierDeploiementReussi(cible.uuid);
  if (d?.commit !== sha) return { ok: false, code: 'SHA_NON_DEPLOYE', precedent: d?.commit ?? null };
  if (!(await sonde(f, cible.sonde, sha, { sleep, essais }))) return { ok: false, code: 'SANTE_KO', precedent: d.commit };
  return { ok: true, code: 'OK', precedent: d.commit };
}

// Déploie un SHA sur une application et attend déploiement + sonde (qui doit annoncer ce SHA).
export async function deployerSha({ client, f, cible, sha, sleep, essaisSonde }) {
  const etat = await client.lireApplication(cible.uuid);
  const dejaFixe = etat.sha === sha;
  if (!dejaFixe) await client.fixerSha(cible.uuid, sha);
  const id = await client.deployer(cible.uuid, { force: dejaFixe });
  if (!(await client.attendreDeploiement(id))) return { ok: false, code: 'DEPLOIEMENT_KO' };
  if (!(await sonde(f, cible.sonde, sha, { sleep, essais: essaisSonde }))) return { ok: false, code: 'SANTE_KO' };
  return { ok: true, code: 'OK' };
}

// Essai : déploie le SHA de main s'il ne tourne pas déjà (dernier déploiement réussi + sonde).
export async function synchroniserEssai({ client, f, outil, sha, sleep, journal = () => {} }) {
  verifierSha(sha);
  const cible = outil.essai;
  if (!cible?.uuid) { journal('ESSAI_NON_CONFIGURE'); return { ok: true, change: false, code: 'ESSAI_NON_CONFIGURE' }; }
  if ((await verifierReel({ client, f, cible, sha, sleep, essais: 2 })).ok) {
    journal('ESSAI_A_JOUR');
    return { ok: true, change: false, code: 'ESSAI_A_JOUR' };
  }
  journal('ESSAI_DEPLOIEMENT');
  const r = await deployerSha({ client, f, cible, sha, sleep });
  journal('ESSAI_' + r.code);
  return { ...r, change: true };
}

// Le SHA doit tourner, en bonne santé, sur l'essai (dernier déploiement RÉUSSI + sonde qui annonce le SHA).
export async function verifierEssai({ client, f, outil, sha, sleep }) {
  verifierSha(sha);
  const cible = outil.essai;
  if (!cible?.uuid) return { ok: false, code: 'ESSAI_NON_CONFIGURE' };
  const r = await verifierReel({ client, f, cible, sha, sleep, essais: 3 });
  if (r.ok) return { ok: true, code: 'OK' };
  return { ok: false, code: r.code === 'SHA_NON_DEPLOYE' ? 'SHA_NON_DEPLOYE_SUR_ESSAI' : 'ESSAI_SANTE_KO' };
}

// Production : sauvegarde à la demande, déploiement, sonde, retour arrière automatique si KO.
export async function liberer({ client, f, outil, sha, sleep, journal = () => {} }) {
  verifierSha(sha);
  const cible = outil.production;
  if (!cible?.uuid) { journal('PROD_NON_CONFIGUREE'); return { ok: false, code: 'PROD_NON_CONFIGUREE', retourArriere: false }; }
  const avant = await verifierReel({ client, f, cible, sha, sleep, essais: 2 });
  if (avant.ok) {
    journal('PROD_DEJA_A_JOUR');
    return { ok: true, code: 'PROD_DEJA_A_JOUR', retourArriere: false, precedent: avant.precedent };
  }
  const precedent = HEX40.test(avant.precedent ?? '') && avant.precedent !== sha ? avant.precedent : null; // version qui tourne réellement
  const noms = (await client.listerVariables(cible.uuid)).map((v) => v.key);
  journal(`SAUVEGARDE_VERSION_PRECEDENTE ${precedent ?? 'aucune'} VARIABLES ${noms.length}`);
  const sansBase = !cible.db_uuid;
  if (sansBase) {
    journal('SAUVEGARDE_BASE_AUCUNE');
  } else {
    let ok = false;
    try { ok = (await client.sauvegarderMaintenant(cible.db_uuid)) === true; } catch { ok = false; }
    if (!ok) { journal('SAUVEGARDE_KO'); return { ok: false, code: 'SAUVEGARDE_KO', retourArriere: false, sansBase }; }
    journal('SAUVEGARDE_BASE_OK');
  }
  let r;
  try {
    r = await deployerSha({ client, f, cible, sha, sleep });
  } catch (e) {
    r = { ok: false, code: 'DEPLOIEMENT_KO' };
  }
  if (r.ok) { journal('PROD_OK'); return { ok: true, code: 'PROD_OK', retourArriere: false, precedent, sansBase }; }
  journal('PROD_' + r.code);
  if (!precedent) { journal('RETOUR_ARRIERE_IMPOSSIBLE'); return { ok: false, code: r.code, retourArriere: false, sansBase }; }
  journal('RETOUR_ARRIERE');
  let rb;
  try { rb = await deployerSha({ client, f, cible, sha: precedent, sleep }); } catch { rb = { ok: false }; }
  journal(rb.ok ? 'RETOUR_ARRIERE_OK' : 'RETOUR_ARRIERE_KO');
  return { ok: false, code: r.code, retourArriere: true, retourArriereOk: rb.ok, precedent, sansBase };
}

// Un message de commit vient d'un tiers : texte inerte (sans backtick ni caractère invisible, première ligne,
// dans un bloc inline et avec un préfixe qui le désigne comme tel).
export function messageInerte(message) {
  const ligne = String(message ?? '').split(/\r?\n/)[0];
  return ligne.replace(/[`\p{C}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

// Résumé lisible pour $GITHUB_STEP_SUMMARY, avant l'approbation.
export function resumeChangements({ outil, sha, commits = [], depuis, filiation, baseDeclaree }) {
  const l = [
    `## Mise en production de ${outil}`,
    '',
    `- Version à mettre en ligne : \`${sha.slice(0, 12)}\``,
    `- Vérifiée sur le site d'essai : oui`,
    `- Issue de main : ${filiation ? 'oui' : 'NON'}`,
    depuis ? `- Depuis : \`${depuis.slice(0, 12)}\`` : '- Depuis : non précisé (derniers changements de main)',
    '',
    `### Changements (${commits.length})`,
    ...(commits.length ? commits.map((c) => `- \`${String(c.sha).replace(/[^0-9a-f]/g, '').slice(0, 7)}\` \`message de commit : ${messageInerte(c.message)}\``) : ['- (aucun détail disponible)']),
    '',
    baseDeclaree ? '- Base de données : sauvegarde à la demande avant le déploiement (échec = rien n\'est déployé).' : '- Base de données : pas de base de données déclarée, aucune sauvegarde de base ne sera faite.',
    '',
    'Avant de déployer : sauvegarde. Si la sonde de santé échoue : retour arrière automatique.',
  ];
  return l.join('\n') + '\n';
}

export { masquer };
