// Surveillance des sources entre deux collectes : mémoire publiée avec la page
// (data/health.json), relue à la collecte suivante. Deux alertes :
//   - failing    : fournisseur non lu depuis FAILING_ALERT_MS (une seule alerte par épisode)
//   - recovered  : fin d'un épisode signalé
//   - structure  : composants publiés par la page ajoutés ou retirés (réorganisation, renommage)
// Pur : aucun réseau, aucun fichier. Les sources « unavailable » (aucune requête) sont ignorées
export const FAILING_ALERT_MS = 60 * 60 * 1000;
export const HEALTH_SCHEMA = 1;
const MAX_LISTED = 50;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const names = (provider) => [...new Set(provider.components.map((c) => c.name))].sort();
const validPrevious = (entry) => isObject(entry)
  && (entry.components === null || (Array.isArray(entry.components) && entry.components.every((n) => typeof n === 'string')))
  && (entry.failingSince === null || Number.isFinite(Date.parse(entry.failingSince)))
  && typeof entry.alerted === 'boolean';

export function computeHealth(previous, doc, declared) {
  const now = Date.parse(doc.generatedAt);
  const before = isObject(previous) && previous.schemaVersion === HEALTH_SCHEMA && isObject(previous.providers) ? previous.providers : {};
  const unavailable = new Set(declared.filter((d) => d.source?.kind === 'unavailable').map((d) => d.id));
  const providers = {};
  const alerts = [];
  for (const p of doc.providers) {
    if (unavailable.has(p.id)) continue;
    const prev = Object.hasOwn(before, p.id) && validPrevious(before[p.id]) ? before[p.id] : null;
    if (p.collect.state === 'ok') {
      const current = names(p);
      if (prev?.components) {
        const added = current.filter((n) => !prev.components.includes(n));
        const removed = prev.components.filter((n) => !current.includes(n));
        if (added.length || removed.length) alerts.push({ type: 'structure', id: p.id, name: p.name, added: added.slice(0, MAX_LISTED), removed: removed.slice(0, MAX_LISTED) });
      }
      if (prev?.alerted) alerts.push({ type: 'recovered', id: p.id, name: p.name });
      providers[p.id] = { components: current, failingSince: null, alerted: false };
      continue;
    }
    // Non lu : la référence de structure est conservée, l'épisode d'échec démarre ou continue
    const failingSince = prev?.failingSince ?? doc.generatedAt;
    let alerted = prev?.alerted ?? false;
    if (!alerted && now - Date.parse(failingSince) >= FAILING_ALERT_MS) {
      alerts.push({ type: 'failing', id: p.id, name: p.name, since: failingSince, error: p.collect.error ?? null });
      alerted = true;
    }
    providers[p.id] = { components: prev?.components ?? null, failingSince, alerted };
  }
  return { health: { schemaVersion: HEALTH_SCHEMA, generatedAt: doc.generatedAt, providers }, alerts };
}
