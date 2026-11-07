// Client minimal de l'API Coolify (v4). Node 20+, zéro dépendance.
// Le jeton n'apparaît jamais dans une erreur, un journal ou un message.

// `code` : identifiant fixe, seul élément autorisé dans les journaux publics (jamais `message`).
export class CoolifyError extends Error {
  constructor(message, statut, code) {
    super(message);
    this.name = 'CoolifyError';
    this.statut = statut;
    this.code = code ?? (statut !== undefined ? `ERREUR_COOLIFY_${statut}` : 'ERREUR_COOLIFY');
  }
}

// [À CONFIRMER en E20] Routes dont l'existence n'est pas garantie dans l'API Coolify.
// Isolées ici : toute réponse inattendue (404, etc.) fait échouer fermé (SAUVEGARDE_KO).
export const ROUTES_INCERTAINES = {
  sauvegardes: (db) => `/databases/${db}/backups`,
  executions: (db, bk) => `/databases/${db}/backups/${bk}/executions`, // GET = liste
  lancerSauvegarde: (db, bk) => `/databases/${db}/backups/${bk}/executions`, // POST = sauvegarde à la demande
  imageParEmpreinte: (uuid) => `/applications/${uuid}`, // PATCH docker_registry_image_name/tag
};

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

function segment(valeur, nom) {
  if (typeof valeur !== 'string' || !SEGMENT.test(valeur)) {
    throw new CoolifyError(`${nom} invalide`, undefined, 'ENTREE_INVALIDE');
  }
  return valeur;
}

export function masquer(texte, secrets) {
  let sortie = String(texte);
  for (const s of secrets) {
    if (s && s.length >= 4) sortie = sortie.split(s).join('***');
  }
  return sortie;
}

export function creerClient({ url, jeton, fetch: f = globalThis.fetch, sleep, delaiMs = 3000, essaisMax = 100 } = {}) {
  if (!url || !jeton) throw new CoolifyError('URL ou jeton Coolify manquant', undefined, 'COOLIFY_NON_CONFIGURE');
  let base;
  try {
    base = new URL(url);
  } catch {
    throw new CoolifyError('URL Coolify invalide', undefined, 'COOLIFY_URL_INVALIDE');
  }
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(base.hostname))) {
    throw new CoolifyError('URL Coolify : https obligatoire', undefined, 'COOLIFY_URL_INVALIDE');
  }
  const racine = base.origin + base.pathname.replace(/\/+$/, '') + '/api/v1';
  const secrets = [jeton, url];
  const attendre = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));

  async function appel(methode, chemin, corps) {
    let rep;
    try {
      rep = await f(racine + chemin, {
        method: methode,
        headers: {
          Authorization: `Bearer ${jeton}`,
          Accept: 'application/json',
          ...(corps !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: corps !== undefined ? JSON.stringify(corps) : undefined,
      });
    } catch (e) {
      throw new CoolifyError(`Coolify injoignable (${masquer(e?.message ?? 'erreur', secrets).slice(0, 120)})`, undefined, 'ERREUR_COOLIFY_RESEAU');
    }
    let donnees = null;
    const texte = await rep.text();
    if (texte) {
      try { donnees = JSON.parse(texte); } catch { donnees = null; }
    }
    if (!rep.ok) {
      const detail = masquer(donnees?.message ?? '', secrets).slice(0, 160);
      throw new CoolifyError(`Coolify ${rep.status} sur ${methode} ${chemin.split('?')[0]}${detail ? ' : ' + detail : ''}`, rep.status);
    }
    return donnees;
  }

  return {
    // Crée une application depuis un dépôt GitHub PUBLIC, figée sur un SHA précis.
    async creerApplication({ projet, serveur, environnement = 'production', depot, sha, nom, branche = 'main', port = '3000', buildPack = 'nixpacks' }) {
      verifierSha(sha);
      if (!/^[\w.-]+\/[\w.-]+$/.test(depot ?? '')) throw new CoolifyError('dépôt invalide', undefined, 'ENTREE_INVALIDE');
      const r = await appel('POST', '/applications/public', {
        project_uuid: projet,
        server_uuid: serveur,
        environment_name: environnement,
        git_repository: `https://github.com/${depot}`,
        git_branch: branche,
        git_commit_sha: sha,
        build_pack: buildPack,
        ports_exposes: String(port),
        name: nom,
        instant_deploy: false,
      });
      return r?.uuid;
    },
    async majApplication(uuid, champs) {
      segment(uuid, 'uuid');
      if (champs.git_commit_sha !== undefined) verifierSha(champs.git_commit_sha);
      return appel('PATCH', `/applications/${uuid}`, champs);
    },
    async fixerSha(uuid, sha) {
      verifierSha(sha);
      return this.majApplication(uuid, { git_commit_sha: sha });
    },
    async lireApplication(uuid) {
      segment(uuid, 'uuid');
      const a = await appel('GET', `/applications/${uuid}`);
      return { sha: a?.git_commit_sha ?? null, statut: a?.status ?? 'inconnu', brut: a };
    },
    // Lance un déploiement ; renvoie l'identifiant du déploiement.
    async deployer(uuid, { force = false } = {}) {
      segment(uuid, 'uuid');
      const r = await appel('GET', `/deploy?uuid=${uuid}&force=${force ? 'true' : 'false'}`);
      const id = r?.deployments?.[0]?.deployment_uuid;
      if (!id) throw new CoolifyError('déploiement non lancé', undefined, 'DEPLOIEMENT_NON_LANCE');
      return id;
    },
    async lireDeploiement(id) {
      segment(id, 'id');
      const d = await appel('GET', `/deployments/${id}`);
      return d?.status ?? 'inconnu';
    },
    // Attend la fin ; renvoie true si "finished", false si échec ou délai dépassé.
    async attendreDeploiement(id) {
      for (let i = 0; i < essaisMax; i++) {
        const s = await this.lireDeploiement(id);
        if (s === 'finished') return true;
        if (s === 'failed' || s === 'cancelled-by-user') return false;
        await attendre(delaiMs);
      }
      return false;
    },
    // [À CONFIRMER en E20] liste les sauvegardes planifiées d'une base.
    async sauvegardesBase(dbUuid) {
      segment(dbUuid, 'uuid');
      const l = await appel('GET', ROUTES_INCERTAINES.sauvegardes(dbUuid));
      return Array.isArray(l) ? l : [];
    },
    // [À CONFIRMER en E20] Sauvegarde À LA DEMANDE puis attente de son succès. false = échec ou délai.
    async sauvegarderMaintenant(dbUuid) {
      segment(dbUuid, 'uuid');
      const bk = (await this.sauvegardesBase(dbUuid))[0]?.uuid;
      if (!bk) return false;
      segment(bk, 'uuid');
      const lister = async () => {
        const l = await appel('GET', ROUTES_INCERTAINES.executions(dbUuid, bk));
        return Array.isArray(l) ? l : Array.isArray(l?.executions) ? l.executions : [];
      };
      const avant = new Set((await lister()).map((e) => e?.uuid));
      await appel('POST', ROUTES_INCERTAINES.lancerSauvegarde(dbUuid, bk), {});
      for (let i = 0; i < essaisMax; i++) {
        const nouvelle = (await lister()).find((e) => e?.uuid && !avant.has(e.uuid));
        if (nouvelle?.status === 'success') return true;
        if (nouvelle?.status === 'failed') return false;
        await attendre(delaiMs);
      }
      return false;
    },
    // Dernier déploiement TERMINÉ avec succès (c'est lui qui tourne, même si un déploiement plus récent a échoué).
    async dernierDeploiementReussi(uuid) {
      segment(uuid, 'uuid');
      const r = await appel('GET', `/deployments/applications/${uuid}`);
      const l = Array.isArray(r) ? r : Array.isArray(r?.deployments) ? r.deployments : [];
      const date = (d) => (typeof d?.created_at === 'number' ? d.created_at : Date.parse(d?.created_at ?? '') || 0);
      const ok = l.filter((d) => d?.status === 'finished' && typeof d.commit === 'string' && !(Number(d.pull_request_id) > 0))
        .sort((a, b) => date(b) - date(a));
      return ok.length ? { commit: ok[0].commit.toLowerCase(), id: ok[0].deployment_uuid ?? null } : null;
    },
    // [À CONFIRMER en E20] Chemin cible du plan : image construite sans jeton, déployée par empreinte.
    async fixerImage(uuid, image, empreinte) {
      segment(uuid, 'uuid');
      if (!/^[a-z0-9][a-z0-9._\/-]{0,200}$/.test(image ?? '')) throw new CoolifyError('image invalide', undefined, 'ENTREE_INVALIDE');
      if (!/^sha256:[0-9a-f]{64}$/.test(empreinte ?? '')) throw new CoolifyError('empreinte invalide', undefined, 'ENTREE_INVALIDE');
      return appel('PATCH', ROUTES_INCERTAINES.imageParEmpreinte(uuid), { docker_registry_image_name: image, docker_registry_image_tag: empreinte });
    },
    async listerVariables(uuid) {
      segment(uuid, 'uuid');
      const l = await appel('GET', `/applications/${uuid}/envs`);
      return Array.isArray(l) ? l : [];
    },
    // Crée ou met à jour une variable. La valeur n'est jamais renvoyée ni journalisée.
    async poserVariable(uuid, cle, valeur) {
      segment(uuid, 'uuid');
      if (!/^[A-Z_][A-Z0-9_]{0,63}$/.test(cle ?? '')) throw new CoolifyError('nom de variable invalide', undefined, 'ENTREE_INVALIDE');
      const existe = (await this.listerVariables(uuid)).some((v) => v.key === cle);
      return appel(existe ? 'PATCH' : 'POST', `/applications/${uuid}/envs`, { key: cle, value: String(valeur) });
    },
  };
}

export function verifierSha(sha) {
  if (typeof sha !== 'string' || !/^[0-9a-f]{40}$/.test(sha)) throw new CoolifyError('SHA invalide (40 caractères hexadécimaux)', undefined, 'SHA_INVALIDE');
  return sha;
}
