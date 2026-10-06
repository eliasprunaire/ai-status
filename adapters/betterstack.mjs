import { fail } from '../lib/errors.mjs';
import { STATUS_LIMITS } from '../public/status-contract.js';

// Pages Better Stack (Together AI) : endpoint public documenté /index.json
// (https://betterstack.com/docs/uptime/status-pages/subscribing-to-status-updates/subscribing-to-api/)
// Réponse JSON:API : data.attributes.aggregate_state, included[] de types
// status_page_resource (status), status_report (incidents et maintenances, ends_at null si en cours)
const STATE = { operational: 'operationnel', degraded: 'degradation', downtime: 'incident_majeur', maintenance: 'maintenance' };

export function betterstackStatus(state) {
  return STATE[state] ?? 'inconnu';
}

// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'API Better Stack', en: 'Better Stack API' };

const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
// Un incident est ouvert tant que ends_at est null. Une maintenance a une fin planifiée :
// elle reste à afficher tant que cette fin n'est pas passée (à venir ou en cours)
const pending = (attributes) => attributes.ends_at === null
  || (attributes.report_type === 'maintenance' && Date.parse(attributes.ends_at) > Date.now());

export async function collect(provider, get) {
  const doc = await get(provider.source.url.replace(/\/+$/, '') + '/index.json');
  const aggregate = doc?.data?.attributes?.aggregate_state;
  const included = doc?.included;
  const resourceRefs = doc?.data?.relationships?.resources?.data;
  const reportRefs = doc?.data?.relationships?.status_reports?.data;
  if (typeof aggregate !== 'string' || !Array.isArray(included) || !Array.isArray(resourceRefs) || resourceRefs.length > STATUS_LIMITS.components || !Array.isArray(reportRefs) || reportRefs.length > STATUS_LIMITS.events) throw fail('schema', 'index.json (aggregate_state / relationships / included)');
  const indexed = new Map();
  for (const item of included) {
    if (!['status_page_resource', 'status_report'].includes(item?.type)) continue;
    if (typeof item.id !== 'string' || !item.id) throw fail('schema', 'index.json (included id)');
    const key = `${item.type}:${item.id}`;
    if (indexed.has(key)) throw fail('schema', 'index.json (included duplicate)');
    indexed.set(key, item);
  }
  const resolve = (refs, type) => {
    const seen = new Set();
    return refs.map((ref) => {
      if (ref?.type !== type || typeof ref.id !== 'string' || !ref.id || seen.has(ref.id)) throw fail('schema', `index.json (${type} relationship)`);
      seen.add(ref.id);
      const item = indexed.get(`${type}:${ref.id}`);
      if (!item) throw fail('schema', `index.json (${type} missing)`);
      return item;
    });
  };
  const resources = resolve(resourceRefs, 'status_page_resource');
  if (resources.length === 0) throw fail('schema', 'index.json (0 status_page_resource)');
  if (resources.some((resource) => typeof resource.attributes?.public_name !== 'string' || !resource.attributes.public_name || typeof resource.attributes.status !== 'string')) throw fail('schema', 'index.json (status_page_resource attributes)');
  const nameOf = new Map(resources.map((resource) => [resource.id, resource.attributes.public_name]));
  // not_monitored : la page ne mesure pas cette ressource, on ne la déclare pas saine
  const components = resources.map((r) => ({ name: r.attributes?.public_name ?? String(r.id), status: betterstackStatus(r.attributes?.status) }));
  const reports = resolve(reportRefs, 'status_report').map((report) => {
    const attributes = report.attributes;
    if (!attributes || typeof attributes.title !== 'string' || !attributes.title || typeof attributes.report_type !== 'string' || !Object.hasOwn(attributes, 'ends_at') || !(attributes.ends_at === null || validDate(attributes.ends_at)) || !Array.isArray(attributes.affected_resources) || attributes.affected_resources.length > STATUS_LIMITS.eventComponents) throw fail('schema', 'index.json (status_report attributes)');
    if (attributes.ends_at === null && !validDate(attributes.starts_at)) throw fail('schema', 'index.json (status_report starts_at)');
    const affectedIds = attributes.affected_resources.map((affected) => String(affected?.status_page_resource_id ?? ''));
    if (new Set(affectedIds).size !== affectedIds.length || affectedIds.some((id) => !id || (pending(attributes) && !nameOf.has(id)))) throw fail('schema', 'index.json (affected_resources)');
    return report;
  }).filter((report) => pending(report.attributes));
  const affected = (r) => r.attributes.affected_resources.map((a) => nameOf.get(String(a.status_page_resource_id)));
  const incidents = reports.filter((r) => r.attributes.report_type !== 'maintenance').map((r) => ({
    title: r.attributes.title,
    state: 'en cours',
    impact: r.attributes.aggregate_state == null ? null : betterstackStatus(r.attributes.aggregate_state),
    createdAt: r.attributes.starts_at ?? null,
    updatedAt: null,
    url: null,
    components: affected(r),
  }));
  const maintenances = reports.filter((r) => r.attributes.report_type === 'maintenance').map((r) => ({
    title: r.attributes.title,
    state: r.attributes.starts_at && Date.parse(r.attributes.starts_at) > Date.now() ? 'scheduled' : 'in_progress',
    scheduledFor: r.attributes.starts_at ?? null,
    scheduledUntil: r.attributes.ends_at ?? null,
    url: null,
  }));
  return {
    indicator: betterstackStatus(aggregate),
    rawStatus: aggregate,
    rawIndicator: aggregate,
    components,
    incidents,
    maintenances,
  };
}
