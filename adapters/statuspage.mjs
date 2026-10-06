import { normalizeIndicator, normalizeComponentStatus } from '../lib/normalize.mjs';
import { fail } from '../lib/errors.mjs';

// Adaptateur générique pour les pages Atlassian Statuspage (API v2 publique, sans jeton)
// Un seul appel : /api/v2/summary.json renvoie l'indicateur de page, les composants,
// les incidents non résolus et les maintenances planifiées
// Limite : les composants « only_show_if_degraded » n'apparaissent que dégradés.
// Utilisé par : Anthropic, Cursor, Moonshot, MiniMax, Replicate. Les pages incident.io (OpenAI,
// Groq, Cohere, Fireworks) exposent une émulation de cette API qui tronque les composants à 25
// et omet les incidents : elles passent par adapters/incidentio.mjs. Les deux tableaux
// d'événements sont donc exigés ici, pour qu'une émulation incomplète ne passe jamais pour saine
// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'API Statuspage', en: 'Statuspage API' };

const INCIDENT_STATES = new Set(['investigating', 'identified', 'monitoring', 'resolved']);
const MAINTENANCE_STATES = new Set(['scheduled', 'in_progress', 'verifying', 'completed']);

export async function collect(provider, get) {
  const base = provider.source.url.replace(/\/+$/, '');
  const data = await get(`${base}/api/v2/summary.json`);
  const indicator = data?.status?.indicator;
  if (typeof indicator !== 'string' || !Array.isArray(data.components) || !Array.isArray(data.incidents) || !Array.isArray(data.scheduled_maintenances)) throw fail('schema', 'summary.json (status.indicator / components / incidents / scheduled_maintenances)');
  let incidents = data.incidents;
  let scheduledMaintenances = data.scheduled_maintenances;
  let selected = data.components;
  const filter = provider.source.componentIds;
  if (filter !== undefined) {
    if (!filter || typeof filter !== 'object' || Array.isArray(filter) || Object.keys(filter).length === 0) throw fail('scope', 'componentIds');
    selected = Object.entries(filter).map(([id, name]) => {
      const matches = data.components.filter((c) => c?.id === id);
      if (typeof name !== 'string' || !name || matches.length !== 1 || matches[0].group || matches[0].name !== name) throw fail('scope', `composant ${id}`, `component ${id}`);
      return matches[0];
    });
    const scopedEvents = (events, states, done) => events.flatMap((event) => {
      if (!event || !states.has(event.status)) throw fail('schema', 'Statuspage event.status');
      if (event.status === done) return [];
      // Un événement sans composant (fréquent chez Cloudflare) ne vise pas le périmètre filtré
      if (!Array.isArray(event.components)) throw fail('schema', 'Statuspage event.components');
      if (event.components.length === 0) return [];
      const seen = new Set();
      for (const c of event.components) {
        if (!c || typeof c.id !== 'string' || !c.id || seen.has(c.id)) throw fail('schema', 'Statuspage event.components');
        seen.add(c.id);
        if (Object.hasOwn(filter, c.id) && c.name !== filter[c.id]) throw fail('scope', 'identité de composant', 'component identity');
      }
      const components = event.components.filter((c) => Object.hasOwn(filter, c.id));
      return components.length ? [{ ...event, components }] : [];
    });
    incidents = scopedEvents(incidents, INCIDENT_STATES, 'resolved');
    scheduledMaintenances = scopedEvents(scheduledMaintenances, MAINTENANCE_STATES, 'completed');
  }

  // Les groupes agrègent leurs enfants : ignorés pour ne pas compter deux fois
  const components = selected
    .filter((c) => !c.group)
    .map((c) => ({ name: c.name, status: normalizeComponentStatus(c.status) }));
  if (incidents.some((incident) => !INCIDENT_STATES.has(incident?.status)) || scheduledMaintenances.some((maintenance) => !MAINTENANCE_STATES.has(maintenance?.status))) throw fail('schema', 'summary.json (incident / maintenance status)');
  const maintenances = scheduledMaintenances
    .filter((m) => m.status !== 'completed')
    .map((m) => ({
      title: m.name,
      state: m.status, // scheduled | in_progress | verifying
      scheduledFor: m.scheduled_for ?? null,
      scheduledUntil: m.scheduled_until ?? null,
      url: m.shortlink ?? null,
    }));

  return {
    indicator: filter === undefined ? normalizeIndicator(indicator) : null,
    rawStatus: filter === undefined ? data.status?.description ?? null : null,
    rawIndicator: indicator,
    components,
    incidents: incidents.filter((i) => i.status !== 'resolved').map((i) => ({
      title: i.name,
      state: i.status, // investigating | identified | monitoring
      // Impact normalisé dans les deux modes : « major » brut était lu comme une simple dégradation
      impact: i.impact == null || i.impact === 'none' ? null : normalizeIndicator(i.impact),
      createdAt: i.created_at ?? null,
      updatedAt: i.updated_at ?? null,
      url: i.shortlink ?? null,
      components: (i.components ?? []).map((c) => c.name),
    })),
    maintenances,
  };
}
