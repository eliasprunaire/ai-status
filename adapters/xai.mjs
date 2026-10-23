import { fail } from '../lib/errors.mjs';
import { attribute, elements, elementText, wholeElement } from '../lib/markup.mjs';

const schema = (detail) => { throw fail('schema', `flux RSS xAI (${detail})`, `xAI RSS feed (${detail})`); };

// Le flux est un historique d'incidents : un item « resolved » est passé, tout autre état est
// un incident en cours. La page HTML de status.x.ai est derrière un challenge Cloudflare, le
// RSS est la seule source lisible. Sévérité xAI → état du contrat ; inconnue → dégradation
const SEVERITY = { outage: 'incident_majeur', disruption: 'degradation', degraded: 'degradation', maintenance: 'maintenance' };
const STATE = { investigating: 'investigating', identified: 'identified', monitoring: 'monitoring' };

export function parseXaiRss(xml) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) schema('XML refusé');
  const root = wholeElement(xml, 'rss', { declaration: true });
  if (!root || attribute(root.attributes, 'version') !== '2.0') schema('rss 2.0');
  const channel = wholeElement(root.body, 'channel');
  if (!channel) schema('channel');

  const items = elements(channel.body, 'item');
  if (!items) schema('item');
  const header = items.length ? channel.body.slice(0, items[0].start) : channel.body;
  if (elementText(header, 'link') !== 'https://status.x.ai') schema('identité du canal');

  // Un même incident est publié une fois par composant touché : l'unicité porte sur le couple.
  // Un item inattendu (identifiant, titre, lien, état) est écarté et compté, au lieu de rendre
  // tout le flux illisible ; au-delà de la moitié des items, le flux est rejeté
  const seen = new Set();
  const parsed = [];
  const ignored = [];
  for (const { body } of items) {
    try {
      const item = parseItem(body);
      const key = `${item.component}\n${item.guid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parsed.push(item);
    } catch (error) {
      if (error?.code !== 'schema') throw error;
      const status = (elementText(body, 'description') ?? '').match(/<h3>Status:\s*([^<]+)<\/h3>/i)?.[1]?.trim().toLowerCase();
      ignored.push({ active: status !== 'resolved', reason: error.detail });
    }
  }
  if (items.length && ignored.length * 2 > items.length) schema(`items illisibles (${ignored.length}/${items.length})`);
  return { items: parsed, ignored };
}

function parseItem(body) {
  const title = elementText(body, 'title');
  const link = elementText(body, 'link');
  const guid = elementText(body, 'guid');
  const description = elementText(body, 'description');
  const pubDate = elementText(body, 'pubDate');
  const titleParts = title?.match(/^\[([^\]]+)]\s+(.+)$/);
  if (!titleParts) schema('titre');
  const component = titleParts[1].trim();
  // Identifiant opaque : xAI a publié INC… puis ps_… ; seul le format borné est exigé
  if (!guid || !/^[A-Za-z0-9_-]{1,64}$/.test(guid)) schema('guid');
  if (!pubDate || !Number.isFinite(Date.parse(pubDate))) schema('pubDate');

  let url;
  try {
    url = new URL(link);
  } catch {
    schema('lien incident');
  }
  if (url.origin !== 'https://status.x.ai' || url.username || url.password || !url.pathname.endsWith(`/${guid}`)) schema('lien incident');

  const statuses = [...(description ?? '').matchAll(/<h3>Status:\s*([^<]+)<\/h3>/gi)];
  const severities = [...(description ?? '').matchAll(/<p>Severity:\s*([^<]+)<\/p>/gi)];
  if (statuses.length !== 1 || severities.length > 1) schema('état');
  const status = statuses[0][1].trim().toLowerCase();
  const severity = severities.length ? severities[0][1].trim().toLowerCase() : null;
  return {
    component,
    title: titleParts[2],
    guid,
    active: status !== 'resolved',
    state: STATE[status] ?? 'en cours',
    impact: SEVERITY[severity] ?? 'degradation',
    pubDate: new Date(pubDate).toISOString(),
    url: url.href,
  };
}

export const METHOD = { fr: 'flux RSS officiel xAI', en: 'official xAI RSS feed' };

export async function collect(provider, get) {
  const declared = provider.source.components;
  if (!Array.isArray(declared) || declared.length === 0 || declared.some((name) => typeof name !== 'string' || !name) || new Set(declared).size !== declared.length) schema('liste des composants');
  const { items, ignored } = parseXaiRss(await get(provider.source.url, { as: 'text', accept: 'application/rss+xml,application/xml,text/xml' }));
  const active = items.filter((item) => item.active);

  // Composants déclarés, plus tout composant touché par un incident en cours : un service
  // renommé ou ajouté par xAI reste visible au lieu de casser la lecture
  const names = [...declared, ...active.map((item) => item.component).filter((name) => !declared.includes(name))];
  const rank = ['operationnel', 'maintenance', 'degradation', 'incident_majeur'];
  const statusOf = (name) => active
    .filter((item) => item.component === name)
    .reduce((worst, item) => (rank.indexOf(item.impact) > rank.indexOf(worst) ? item.impact : worst), 'operationnel');

  // Un incident par guid, avec tous ses composants
  const incidents = [];
  for (const item of active) {
    const existing = incidents.find((incident) => incident.guid === item.guid);
    if (existing) {
      if (!existing.components.includes(item.component)) existing.components.push(item.component);
      if (rank.indexOf(item.impact) > rank.indexOf(existing.impact)) existing.impact = item.impact;
      continue;
    }
    incidents.push({ guid: item.guid, title: item.title, state: item.state, impact: item.impact, createdAt: item.pubDate, url: item.url, components: [item.component] });
  }

  // Un item écarté qui n'est pas résolu : incident possible non lisible, jamais vert
  const unreadActive = ignored.filter((item) => item.active).length;
  const components = names.map((name) => ({ name, status: statusOf(name) }));
  if (unreadActive) components.push({ name: 'Incident en cours non lisible', status: 'inconnu' });
  return {
    indicator: null,
    rawStatus: `${items.length} incidents publiés, ${incidents.length} en cours`,
    components,
    incidents: incidents.map(({ guid, ...incident }) => incident),
    note: ignored.length ? `${ignored.length} élément(s) du flux écarté(s) : format inattendu` : null,
    noteEn: ignored.length ? `${ignored.length} feed item(s) skipped: unexpected format` : null,
  };
}
