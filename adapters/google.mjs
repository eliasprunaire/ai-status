import { normalizeGoogleImpact, worstOf } from '../lib/normalize.mjs';
import { fail } from '../lib/errors.mjs';
import { STATUS_LIMITS } from '../public/status-contract.js';

// Google Cloud Service Health publie deux flux JSON officiels :
//   /products.json  : liste des produits (id, title)
//   /incidents.json : incidents des derniers mois, `end` null tant qu'ils sont ouverts,
//                     `affected_products[].id`, `status_impact`
// Le périmètre est restreint aux produits dont le titre commence par un des
// `source.productPrefixes` (Vertex, Gemini) : le reste de GCP est ignoré.
// Un état « opérationnel » signifie ici « aucun incident déclaré sur ce périmètre »,
// pas une mesure directe du produit.
// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'flux JSON Google Cloud', en: 'Google Cloud JSON feeds' };

const validDate = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));

export async function collect(provider, get) {
  const base = provider.source.url.replace(/\/+$/, '');
  const prefixes = provider.source.productPrefixes ?? [];
  const inScope = (title) => prefixes.some((p) => (title ?? '').startsWith(p));
  const [pdoc, incidents] = await Promise.all([get(`${base}/products.json`), get(`${base}/incidents.json`)]);
  const products = pdoc?.products;
  if (!Array.isArray(products) || products.length > STATUS_LIMITS.components || !Array.isArray(incidents) || incidents.length > STATUS_LIMITS.events) throw fail('schema', 'products.json / incidents.json');
  const catalog = new Map();
  for (const product of products) {
    if (!product || typeof product.id !== 'string' || !product.id || typeof product.title !== 'string' || !product.title || catalog.has(product.id)) throw fail('schema', 'products.json (id / title)');
    catalog.set(product.id, product.title);
  }
  const scoped = products.filter((product) => inScope(product.title));
  if (scoped.length === 0) throw fail('scope', `${prefixes.join(', ')} (products.json)`);
  const scopedById = new Map(scoped.map((product) => [product.id, product.title]));
  const statusById = new Map(scoped.map((product) => [product.id, []]));

  const ongoing = [];
  const incidentIds = new Set();
  for (const incident of incidents) {
    if (!incident || typeof incident.id !== 'string' || !incident.id || incidentIds.has(incident.id) || !Object.hasOwn(incident, 'end') || !(incident.end === null || validDate(incident.end)) || !Array.isArray(incident.affected_products) || incident.affected_products.length > STATUS_LIMITS.eventComponents) throw fail('schema', 'incidents.json (id / end / affected_products)');
    incidentIds.add(incident.id);
    const affectedIds = new Set();
    for (const product of incident.affected_products) {
      if (!product || typeof product.id !== 'string' || !product.id || affectedIds.has(product.id)) throw fail('schema', 'incidents.json (affected_products.id)');
      affectedIds.add(product.id);
    }
    if (incident.end !== null) continue;
    // Produit absent du catalogue : ignoré s'il est hors périmètre ; s'il porte un titre du
    // périmètre (nouveau produit Vertex / Gemini), illisible plutôt qu'ignoré
    if (incident.affected_products.some((product) => !catalog.has(product.id) && inScope(product.title))) throw fail('scope', 'incidents.json (produit du périmètre absent du catalogue)');
    const productIds = [...affectedIds].filter((id) => scopedById.has(id));
    const impact = normalizeGoogleImpact(incident.status_impact);
    if (productIds.length === 0) continue;
    for (const id of productIds) statusById.get(id).push(impact);
    ongoing.push({
      title: incident.external_desc ?? incident.service_name ?? 'incident',
      impact,
      productIds,
      products: productIds.map((id) => scopedById.get(id)),
      startedAt: incident.begin ?? null,
      updatedAt: incident.modified ?? null,
      url: incident.uri ? `${base}${incident.uri.startsWith('/') ? '' : '/'}${incident.uri}` : null,
    });
  }

  const impacted = [...new Set(ongoing.flatMap((i) => i.products))];
  return {
    indicator: null,
    rawStatus:
      ongoing.length === 0
        ? `Aucun incident déclaré (périmètre ${prefixes.join(' / ')}, ${scoped.length} produits)`
        : `${ongoing.length} incident(s) en cours : ${impacted.join(', ')}`,
    rawIndicator: ongoing.length === 0 ? 'no_incident' : 'incident',
    components: scoped.map((product) => ({ name: product.title, status: worstOf(statusById.get(product.id)) })),
    incidents: ongoing.map((i) => ({
      title: i.title,
      state: 'en cours',
      impact: i.impact,
      createdAt: i.startedAt,
      updatedAt: i.updatedAt,
      url: i.url,
      components: i.products,
    })),
  };
}
