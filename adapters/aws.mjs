import { worstOf } from '../lib/normalize.mjs';
import { fail } from '../lib/errors.mjs';
import { STATUS_LIMITS } from '../public/status-contract.js';

// AWS Health Dashboard (Amazon Bedrock) : la page health.aws.amazon.com/health/status charge
// deux flux JSON publics sans jeton (observés dans ses requêtes, non documentés par AWS ;
// les flux RSS documentés existent mais un par service et par région) :
//   https://health.aws.amazon.com/public/currentevents          événements en cours, encodés en UTF-16 (BOM)
//   https://servicedata-<région>-prod.s3.amazonaws.com/services.json  catalogue service × région (BOM UTF-8)
// Code d'état AWS (bundle de la page) : 0 resolved, 1 impacted (info), 2 degraded, 3 disrupted.
// Le périmètre est restreint aux services dont service_name vaut source.serviceName
const CODE = { 1: 'degradation', 2: 'degradation', 3: 'incident_majeur' };
// 5 848 lignes observées le 2026-09-04 ; marge bornée sous la limite HTTP de 2 Mio
const CATALOG_LIMIT = 10_000;

export function awsCode(code) {
  const n = Number(code);
  return n === 0 ? 'operationnel' : CODE[n] ?? 'inconnu';
}

// fetch décode toujours en UTF-8 : on lit les octets et on détecte le BOM
export function decodeAwsBody(bytes) {
  const enc = bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : 'utf-8';
  return JSON.parse(new TextDecoder(enc, { ignoreBOM: false }).decode(bytes));
}

// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'flux JSON AWS Health', en: 'AWS Health JSON feeds' };

const validEpoch = (value) => (typeof value === 'number' || (typeof value === 'string' && value.trim()))
  && Number.isFinite(Number(value))
  && Number.isFinite(new Date(Number(value) * 1000).getTime());

export async function collect(provider, get) {
  const { eventsUrl, servicesUrl, serviceName } = provider.source;
  const [ebytes, sbytes] = await Promise.all([get(eventsUrl, { as: 'bytes' }), get(servicesUrl, { as: 'bytes' })]);
  const events = decodeAwsBody(ebytes);
  const catalog = decodeAwsBody(sbytes);
  if (!Array.isArray(events) || events.length > STATUS_LIMITS.events || !Array.isArray(catalog) || catalog.length > CATALOG_LIMIT) throw fail('schema', 'currentevents / services.json');
  const scoped = [];
  const byId = new Map();
  const regions = new Set();
  for (const service of catalog) {
    if (service?.service_name !== serviceName) continue;
    if (typeof service.service !== 'string' || !service.service || typeof service.region_id !== 'string' || !service.region_id || typeof service.region_name !== 'string' || !service.region_name || !service.service.endsWith(`-${service.region_id}`) || byId.has(service.service) || regions.has(service.region_id)) throw fail('schema', 'services.json (service / region)');
    scoped.push(service);
    byId.set(service.service, service);
    regions.add(service.region_id);
  }
  if (scoped.length === 0) throw fail('scope', `${serviceName} (services.json)`);
  const label = (s) => `${serviceName} (${s.region_name ?? s.service})`;
  const impacts = new Map(scoped.map((service) => [service.service, []]));
  const incidents = [];
  for (const event of events) {
    if (!event || typeof event !== 'object' || Array.isArray(event) || (event.end_time != null && !validEpoch(event.end_time))) throw fail('schema', 'currentevents (event / end_time)');
    if (event.end_time != null) continue;
    if (event.service_name === serviceName && (typeof event.service !== 'string' || !byId.has(event.service))) throw fail('scope', 'currentevents (service Bedrock inconnu)');
    if (byId.has(event.service) && event.service_name != null && event.service_name !== serviceName) throw fail('schema', 'currentevents (identité service)');
    const affected = new Map();
    if (byId.has(event.service)) {
      const status = awsCode(event.status);
      if (status === 'inconnu') throw fail('schema', 'currentevents (status)');
      if (status !== 'operationnel') affected.set(event.service, status);
    }
    if (event.impacted_services != null && (typeof event.impacted_services !== 'object' || Array.isArray(event.impacted_services))) throw fail('schema', 'currentevents (impacted_services)');
    for (const [id, service] of Object.entries(event.impacted_services ?? {})) {
      if (!byId.has(id)) {
        if (service?.service_name === serviceName) throw fail('scope', 'currentevents (service Bedrock impacté inconnu)');
        continue;
      }
      if (service?.service_name !== serviceName) throw fail('schema', 'currentevents (identité service impacté)');
      const status = awsCode(service?.current);
      if (status === 'inconnu') throw fail('schema', 'currentevents (impacted_services.current)');
      if (status !== 'operationnel') affected.set(id, status);
    }
    if (affected.size === 0) continue;
    if (event.date != null && !validEpoch(event.date)) throw fail('schema', 'currentevents (date)');
    for (const [id, status] of affected) impacts.get(id).push(status);
    // Dernière mise à jour publiée (event_log) : distingue un incident suivi d'un oubli
    const stamps = Array.isArray(event.event_log) ? event.event_log.map((entry) => Number(entry?.timestamp)).filter((t) => validEpoch(t)) : [];
    const base = event.summary ?? event.service_name ?? 'event';
    incidents.push({
      title: typeof event.region_name === 'string' && event.region_name && !base.includes(event.region_name) ? `${base} (${event.region_name})` : base,
      state: 'en cours',
      impact: worstOf(affected.values()),
      createdAt: event.date == null ? null : new Date(Number(event.date) * 1000).toISOString(),
      updatedAt: stamps.length ? new Date(Math.max(...stamps) * 1000).toISOString() : null,
      url: 'https://health.aws.amazon.com/health/status',
      components: [...affected].map(([id]) => label(byId.get(id))),
    });
  }
  const components = scoped.map((service) => ({ name: label(service), status: worstOf(impacts.get(service.service)) }));
  const impacted = new Set(components.filter((c) => c.status !== 'operationnel').map((c) => c.name));
  return {
    indicator: null,
    rawStatus: impacted.size ? `${impacted.size} region(s) impacted` : `No open event (${serviceName}, ${scoped.length} regions)`,
    rawIndicator: impacted.size ? 'open_event' : 'none',
    components,
    incidents,
  };
}
