import { fail } from '../lib/errors.mjs';
import { STATUS_LIMITS, worstOf } from '../public/status-contract.js';

export const METHOD = { fr: 'JSON public Datadog', en: 'Datadog public JSON' };
const STATES = { operational: 'operationnel', degraded: 'degradation', partial_outage: 'degradation', major_outage: 'incident_majeur', maintenance: 'maintenance' };
const mapped = (s) => Object.hasOwn(STATES, s) ? STATES[s] : 'inconnu';
const bad = (field) => { throw fail('schema', `Datadog ${field}`); };
const text = (v) => typeof v === 'string' && v.length > 0 && v.length <= STATUS_LIMITS.string;
const list = (v, limit) => { if (!Array.isArray(v) || v.length > limit) bad('liste'); return v; };
const date = (v) => { if (!text(v) || !Number.isFinite(Date.parse(v))) bad('date'); return v; };
const optionalDate = (v) => v == null || v === '' ? null : date(v);

export async function collect(provider, get) {
  const doc = await get(`${provider.source.url.replace(/\/+$/, '')}/config.json`);
  if (!doc || doc.name !== provider.source.pageName || !text(doc.id) || doc.enabled !== true || doc.pageType !== 'public' || doc.domainPrefix !== provider.source.domainPrefix) bad('identité');
  for (const key of ['next', 'next_page', 'nextCursor', 'pagination']) if (doc[key] != null) bad('pagination non prise en charge');
  const byId = new Map();
  const ids = new Set();
  const components = [];
  const walk = (nodes, depth = 0) => {
    if (depth > 16) bad('profondeur');
    for (const c of list(nodes, STATUS_LIMITS.components)) {
      if (!c || !text(c.id) || !text(c.name) || ids.has(c.id) || ids.size >= STATUS_LIMITS.components) bad('composant');
      ids.add(c.id);
      if (c.type === 'ComponentGroup') { walk(c.components, depth + 1); continue; }
      if (c.type !== 'Component' || !text(c.status)) bad('composant');
      const component = { name: c.name, status: mapped(c.status) };
      byId.set(c.id, component);
      components.push(component);
    }
  };
  walk(doc.components);
  if (!components.length) bad('aucun composant');
  if (provider.source.requiredComponents?.some(name => !components.some(c => c.name === name))) bad('couverture');
  const associated = (event) => {
    const seen = new Set();
    return list(event.componentsAffected, STATUS_LIMITS.eventComponents).map(c => {
      const component = byId.get(c?.id);
      if (!component || c.name !== component.name || seen.has(c.id) || !text(c.status)) bad('association');
      seen.add(c.id);
      return { name: component.name, status: mapped(c.status) };
    });
  };
  const eventIds = new Set();
  const identity = (e) => {
    if (!e || !text(e.id) || eventIds.has(e.id)) bad('événement');
    eventIds.add(e.id);
    if (e.deletedAt != null) { date(e.deletedAt); return false; }
    if (!text(e.title)) bad('titre');
    return true;
  };
  const incidents = [];
  for (const e of list(doc.incidents, STATUS_LIMITS.events)) {
    if (!identity(e)) continue;
    if (!['investigating', 'identified', 'monitoring', 'resolved'].includes(e.currentStatus) || typeof e.resolved !== 'boolean') bad('incident.status');
    const start = date(e.publishedDate);
    const end = optionalDate(e.resolvedDate);
    if (e.resolved !== (e.currentStatus === 'resolved') || e.resolved !== (end !== null) || (end && Date.parse(end) < Date.parse(start))) bad('résolution contradictoire');
    if (e.resolved) continue;
    // Un incident en cours sans composant rattaché reste visible (dégradation) au lieu de rendre
    // toute la page illisible au pire moment
    const refs = associated(e);
    const impact = refs.length ? worstOf(refs.map(c => c.status)) : 'degradation';
    incidents.push({ title: e.title, state: e.currentStatus, impact: impact === 'operationnel' ? 'degradation' : impact, createdAt: start, updatedAt: optionalDate(e.lastModifiedAt), components: refs.map(c => c.name), url: `${provider.statusUrl.replace(/\/+$/, '')}/incidents/${encodeURIComponent(e.id)}` });
  }
  if (!Object.hasOwn(doc, 'maintenances')) bad('maintenances absentes');
  const maintenances = [];
  for (const e of list(doc.maintenances === null ? [] : doc.maintenances, STATUS_LIMITS.events)) {
    if (!identity(e)) continue;
    if (!['scheduled', 'in_progress', 'completed', 'canceled'].includes(e.currentStatus)) bad('maintenance.status');
    const start = optionalDate(e.startDate);
    const end = optionalDate(e.completedDate);
    if ((end && start && Date.parse(end) < Date.parse(start)) || (end && ['scheduled', 'in_progress'].includes(e.currentStatus))) bad('maintenance.date');
    if (['completed', 'canceled'].includes(e.currentStatus)) continue;
    associated(e);
    maintenances.push({ title: e.title, state: e.currentStatus, scheduledFor: start, scheduledUntil: null, url: `${provider.statusUrl.replace(/\/+$/, '')}/maintenances/${encodeURIComponent(e.id)}` });
  }
  return { indicator: null, components, incidents, maintenances };
}
