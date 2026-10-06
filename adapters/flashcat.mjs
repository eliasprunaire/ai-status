import { fail } from '../lib/errors.mjs';
import { worstOf } from '../lib/normalize.mjs';
import { INCIDENT_STATES } from '../public/status-contract.js';

// Pages de statut Flashcat (DeepSeek) : l'API JSON de la SPA est accessible en fetch
// simple : /api/status-page/<pageId>/summary/active renvoie les composants et les
// changements actifs (incidents, maintenances). Forme d'un changement, observée sur
// /change/list (36 incidents sur 120 jours) : type, title, status, start_at_seconds,
// affected_components[].{component_id,status}, updates[].component_changes[].status.
// L'état courant d'un composant est celui d'affected_components, à défaut celui de la
// dernière mise à jour. Un payload sans composants n'est jamais traité comme sain.
// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'API Flashcat', en: 'Flashcat API' };

const STATES = { operational: 'operationnel', degraded: 'degradation', partial_outage: 'degradation', major_outage: 'incident_majeur', full_outage: 'indisponible', under_maintenance: 'maintenance', maintenance: 'maintenance' };
const mapped = (status) => (Object.hasOwn(STATES, status) ? STATES[status] : 'inconnu');
const bad = (field) => { throw fail('schema', `Flashcat ${field}`); };

export async function collect(provider, get) {
  const base = provider.source.url.replace(/\/+$/, '');
  const data = (await get(`${base}/api/status-page/${provider.source.pageId}/summary/active`))?.data;
  const components = data?.page?.components;
  const changes = data?.active_changes;
  if (!Array.isArray(components) || components.length === 0 || !Array.isArray(changes)) bad('summary/active (page.components / active_changes)');
  const byId = new Map();
  for (const c of components) {
    if (!c || typeof c.component_id !== 'string' || typeof c.name !== 'string' || !c.name || byId.has(c.component_id)) bad('composant');
    byId.set(c.component_id, { name: c.name, statuses: [] });
  }

  const incidents = [];
  const maintenances = [];
  for (const change of changes) {
    if (!change || typeof change.title !== 'string' || !Array.isArray(change.affected_components ?? [])) bad('changement');
    const updates = Array.isArray(change.updates) ? change.updates : [];
    const latest = [...updates].sort((a, b) => (b?.at_seconds ?? 0) - (a?.at_seconds ?? 0))[0];
    const fromUpdate = new Map((latest?.component_changes ?? []).map((c) => [c?.component_id, c?.status]));
    const touched = [];
    for (const c of change.affected_components ?? []) {
      if (!c || typeof c.component_id !== 'string') bad('affected_components');
      // « operational » sur un changement actif : l'état de la dernière mise à jour fait foi
      let status = mapped(c.status === 'operational' && fromUpdate.has(c.component_id) ? fromUpdate.get(c.component_id) : c.status);
      if (change.type !== 'maintenance' && status === 'operationnel') status = 'degradation';
      if (byId.has(c.component_id)) {
        byId.get(c.component_id).statuses.push(status);
        touched.push({ name: byId.get(c.component_id).name, status });
      }
    }
    const createdAt = Number.isFinite(change.start_at_seconds) ? new Date(change.start_at_seconds * 1000).toISOString() : null;
    if (change.type === 'maintenance') {
      maintenances.push({ title: change.title, state: 'in_progress', scheduledFor: createdAt, scheduledUntil: Number.isFinite(change.close_at_seconds) && change.close_at_seconds > 0 ? new Date(change.close_at_seconds * 1000).toISOString() : null, url: null });
      continue;
    }
    incidents.push({
      title: change.title,
      state: INCIDENT_STATES.includes(change.status) ? change.status : 'en cours',
      // Sans composant rattaché, l'incident compte au moins comme une dégradation
      impact: touched.length ? worstOf(touched.map((t) => t.status)) : 'degradation',
      createdAt,
      components: touched.map((t) => t.name),
    });
  }

  return {
    indicator: null,
    rawStatus: changes.length === 0 ? `Aucun changement actif (${components.length} services)` : changes.map((c) => c.title).join(' ; '),
    rawIndicator: changes.length === 0 ? 'no_active_change' : 'active_change',
    components: [...byId.values()].map((c) => ({ name: c.name, status: c.statuses.length ? worstOf(c.statuses) : 'operationnel' })),
    incidents,
    maintenances,
  };
}
