import { fail } from '../lib/errors.mjs';
import { elements } from '../lib/markup.mjs';
import { STATUS_LIMITS, worstOf } from '../public/status-contract.js';

export const METHOD = { fr: 'données publiques incident.io', en: 'incident.io public data' };
const STATES = { operational: 'operationnel', under_maintenance: 'maintenance', degraded_performance: 'degradation', partial_outage: 'degradation', full_outage: 'indisponible' };
const mapped = (s) => Object.hasOwn(STATES, s) ? STATES[s] : 'inconnu';
const bad = (field) => { throw fail('schema', `incident.io ${field}`); };
const text = (v) => typeof v === 'string' && v.length > 0 && !v.startsWith('$') && v.length <= STATUS_LIMITS.string;
const list = (v, max) => { if (!Array.isArray(v) || v.length > max) bad('liste'); return v; };
const parseJSON = (v) => { try { return JSON.parse(v); } catch { bad('JSON'); } };
const date = (v) => { if (!text(v) || !Number.isFinite(Date.parse(v))) bad('date'); return v; };

// Lecture de l'enveloppe Flight observée : fragments texte, lignes JSON et blocs T
// Les modules et les scripts tiers ne sont jamais exécutés
export function parseSummary(html) {
  const chunks = [];
  for (const script of elements(html, 'script', { tolerant: true }) ?? []) {
    const match = script.body.trim().match(/^self\.__next_f\.push\(([\s\S]*)\);?$/);
    if (!match) continue;
    const packet = parseJSON(match[1]);
    if (!Array.isArray(packet)) bad('fragment');
    if (packet[0] !== 1) continue;
    if (packet.length !== 2 || typeof packet[1] !== 'string') bad('fragment');
    chunks.push(packet[1]);
  }
  if (!chunks.length) bad('aucun fragment');
  const bytes = Buffer.from(chunks.join(''), 'utf8');
  const records = new Map();
  let pos = 0;
  while (pos < bytes.length) {
    const colon = bytes.indexOf(58, pos);
    if (colon < 0) bad('enregistrement incomplet');
    if (colon === pos && bytes.toString('utf8', pos, pos + 3) === ':HL') {
      const end = bytes.indexOf(10, pos);
      if (end < 0) bad('préchargement tronqué');
      pos = end + 1;
      continue;
    }
    const id = bytes.toString('utf8', pos, colon);
    if (!/^[a-f0-9]+$/.test(id) || records.has(id)) bad('identifiant Flight');
    pos = colon + 1;
    if (bytes[pos] === 84) {
      const comma = bytes.indexOf(44, pos);
      const hex = bytes.toString('utf8', pos + 1, comma);
      if (comma < 0 || !/^[a-f0-9]+$/.test(hex)) bad('longueur texte');
      const end = comma + 1 + parseInt(hex, 16);
      if (end > bytes.length) bad('texte tronqué');
      records.set(id, bytes.toString('utf8', comma + 1, end));
      pos = end;
      continue;
    }
    const end = bytes.indexOf(10, pos);
    if (end < 0) bad('ligne tronquée');
    const row = bytes.toString('utf8', pos, end);
    records.set(id, /^[\[{"\d]|^(?:null|true|false)$/.test(row) ? parseJSON(row) : undefined);
    pos = end + 1;
  }
  const resolve = (value, seen = new Set()) => {
    if (typeof value !== 'string' || !value.startsWith('$')) return value;
    if (seen.has(value)) bad('référence cyclique');
    seen.add(value);
    const match = value.match(/^\$([a-f0-9]+)((?::[\w]+)*)$/);
    if (!match || !records.has(match[1])) bad('référence absente');
    let result = records.get(match[1]);
    for (const part of match[2].split(':').slice(1)) {
      result = resolve(result, new Set(seen));
      const key = part === 'props' && Array.isArray(result) && result[0] === '$' ? '3' : part;
      if (!result || !Object.hasOwn(result, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) bad('chemin de référence');
      result = result[key];
    }
    return resolve(result, seen);
  };
  const summaries = [];
  const walk = (value, depth = 0) => {
    if (depth > 64) bad('profondeur');
    if (!value || typeof value !== 'object') return;
    if (Object.hasOwn(value, 'summary')) {
      const summary = resolve(value.summary);
      if (!summary || typeof summary !== 'object' || Array.isArray(summary)) bad('summary');
      const resolved = { ...summary };
      for (const key of ['components', 'affected_components', 'ongoing_incidents', 'scheduled_maintenances', 'structure']) resolved[key] = resolve(summary[key]);
      summaries.push(resolved);
    }
    for (const child of Object.values(value)) if (child && typeof child === 'object') walk(child, depth + 1);
  };
  for (const value of records.values()) walk(value);
  if (!summaries.length || summaries.some(s => JSON.stringify(s) !== JSON.stringify(summaries[0]))) bad('summary absent ou contradictoire');
  return summaries[0];
}

// Deux accès au même résumé : la page HTML (enveloppe Flight) ou l'endpoint JSON public
// /proxy/<hôte> (source.format = 'proxy'). Ne pas utiliser /api/v2/summary.json de ces pages :
// l'émulation Statuspage d'incident.io tronque les composants à 25 et omet les incidents
async function readSummary(provider, get) {
  if (provider.source.format !== 'proxy') return parseSummary(await get(provider.source.url, { as: 'text' }));
  const base = new URL(provider.source.url);
  const data = await get(`${base.origin}/proxy/${base.host}`);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !data.summary || typeof data.summary !== 'object' || Array.isArray(data.summary)) bad('summary');
  return data.summary;
}

export async function collect(provider, get) {
  const s = await readSummary(provider, get);
  const now = Date.now();
  if ((provider.source.pageName !== undefined && s.name !== provider.source.pageName) || !text(s.id) || s.page_type !== 'standalone' || typeof s.public_url !== 'string' || s.public_url.replace(/\/+$/, '') !== provider.statusUrl.replace(/\/+$/, '')) bad('identité');
  for (const key of ['next', 'next_page', 'nextCursor', 'pagination']) if (s[key] != null && s[key] !== '$undefined') bad('pagination');
  const all = new Map();
  for (const c of list(s.components, STATUS_LIMITS.components)) {
    if (!c || !text(c.id) || !text(c.name) || c.status_page_id !== s.id || all.has(c.id)) bad('composant');
    all.set(c.id, c.name.trim());
  }
  // Seuls les composants affichés par la page officielle (structure, groupes compris, non
  // masqués) sont suivis ; un même nom dans deux groupes est préfixé par son groupe
  const shown = [];
  for (const item of list(s.structure?.items, STATUS_LIMITS.components)) {
    // Dans l'enveloppe Flight, une valeur absente est codée « $undefined »
    const group = item?.group == null || item.group === '$undefined' ? null : item.group;
    const entries = group ? list(group.components, STATUS_LIMITS.components).map(c => [c, group]) : [[item?.component, null]];
    if (group && (!text(group.name) || typeof group.hidden !== 'boolean')) bad('structure');
    for (const [c, parent] of entries) {
      if (!c || !all.has(c.component_id) || c.name.trim() !== all.get(c.component_id) || shown.some(e => e.id === c.component_id) || typeof c.hidden !== 'boolean') bad('structure');
      if (!c.hidden && !parent?.hidden) shown.push({ id: c.component_id, name: all.get(c.component_id), group: parent?.name.trim() ?? null });
    }
  }
  if (!shown.length) bad('aucun composant');
  if (provider.source.requiredComponents?.some(name => !shown.some(c => c.name === name))) bad('couverture');
  const byId = new Map();
  for (const c of shown) {
    const duplicate = shown.filter(other => other.name === c.name).length > 1;
    byId.set(c.id, { name: duplicate && c.group ? `${c.group} · ${c.name}` : c.name, status: 'operationnel' });
  }
  const refs = (values) => {
    const seen = new Set();
    return list(values, STATUS_LIMITS.eventComponents).flatMap(c => {
      if (!c || !all.has(c.component_id) || seen.has(c.component_id) || !text(c.status)) bad('association');
      seen.add(c.component_id);
      return byId.has(c.component_id) ? [{ id: c.component_id, name: byId.get(c.component_id).name, status: mapped(c.status) }] : [];
    });
  };
  // Le lecteur officiel utilise affected_components pour l'état courant, pas l'historique
  for (const c of refs(s.affected_components)) byId.get(c.id).status = c.status;
  const incidents = [];
  const maintenances = [];
  const seen = new Set();
  const events = [
    ...list(s.ongoing_incidents, STATUS_LIMITS.events).map(e => [e, false]),
    ...list(s.scheduled_maintenances, STATUS_LIMITS.events).map(e => [e, true]),
  ];
  if (events.length > STATUS_LIMITS.events) bad('événements');
  for (const [e, scheduled] of events) {
    if (!e || !text(e.id) || !text(e.name) || e.status_page_id !== s.id || seen.has(e.id)) bad('événement');
    seen.add(e.id);
    const associated = refs(e.affected_components);
    const activeImpacts = [];
    const starts = [];
    const ends = [];
    for (const impact of list(e.component_impacts, STATUS_LIMITS.events)) {
      if (!all.has(impact?.component_id) || !text(impact.status)) bad('impact');
      const start = date(impact.start_at);
      const end = impact.end_at == null || impact.end_at === '$undefined' ? null : date(impact.end_at);
      if (end && Date.parse(end) < Date.parse(start)) bad('impact.date');
      starts.push(start);
      ends.push(end);
      if (Date.parse(start) <= now && (!end || Date.parse(end) > now)) activeImpacts.push(mapped(impact.status));
    }
    const first = starts.length ? starts.reduce((a, b) => Date.parse(a) < Date.parse(b) ? a : b) : null;
    const last = ends.length && ends.every(Boolean) ? ends.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : null;
    const createdAt = date(e.published_at);
    const updates = list(e.updates, STATUS_LIMITS.events);
    const times = updates.map(u => date(u.published_at));
    const updatedAt = times.length ? times.reduce((a, b) => Date.parse(a) > Date.parse(b) ? a : b) : createdAt;
    if (Date.parse(updatedAt) < Date.parse(createdAt)) bad('update.date');
    if (updates.some(u => u.published_at === updatedAt && u.to_status !== e.status)) bad('update.status');
    const url = `${provider.statusUrl.replace(/\/+$/, '')}/incidents/${encodeURIComponent(e.id)}`;
    if (e.type === 'maintenance') {
      if (e.status !== (scheduled ? 'maintenance_scheduled' : 'maintenance_in_progress')) bad('maintenance.status');
      // Une maintenance planifiée dont la fenêtre est entièrement passée n'est plus affichée
      if (scheduled && last && Date.parse(last) <= now) continue;
      maintenances.push({ title: e.name.trim(), state: scheduled ? 'scheduled' : 'in_progress', scheduledFor: first, scheduledUntil: last, url });
    } else {
      if (scheduled || e.type !== 'incident' || !['investigating', 'identified', 'monitoring'].includes(e.status)) bad('incident.status');
      const impact = worstOf(activeImpacts);
      incidents.push({ title: e.name.trim(), state: e.status, impact: impact === 'operationnel' ? 'degradation' : impact, createdAt, updatedAt, components: associated.map(c => c.name), url });
    }
  }
  return { indicator: null, components: [...byId.values()], incidents, maintenances };
}
