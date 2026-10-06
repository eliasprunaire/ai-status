import { fail } from '../lib/errors.mjs';
import { attribute, elements, elementText, wholeElement } from '../lib/markup.mjs';

// Volcengine status (status.volcengine.com, plateforme Ark qui sert les modèles Doubao) :
// l'API BFF de la page (/api/v1/shd/prefetch-shd) répond 401 hors navigateur, contrôle
// d'accès non contourné. La page lie un flux RSS officiel par produit et par région :
//   https://status.volcengine.com/rss/zh/<région>/<produit>
// Le flux liste l'historique complet ; un événement terminé porte « (已恢复) » dans son
// titre, un événement en cours ne le porte pas. Titre de canal « …(<région>)服务状态 » :
// une région inconnue renvoie des parenthèses vides et est traitée comme illisible
const REGION = {
  'cn-beijing': '华北2（北京）',
  'cn-beijing2': '华北3（北京）',
  'cn-shanghai': '华东2（上海）',
  'cn-guangzhou': '华南1（广州）',
  'ap-southeast-1': '亚太东南（柔佛）',
};
const schema = (detail) => { throw fail('schema', `flux RSS Volcengine (${detail})`); };

export function parseVolcengineRss(xml, expectedRegion = null) {
  if (typeof xml !== 'string' || /<!DOCTYPE|<!ENTITY/i.test(xml)) schema('XML refusé');
  const root = wholeElement(xml, 'rss', { declaration: true });
  if (!root || attribute(root.attributes, 'version') !== '2.0') schema('rss 2.0');
  const channel = wholeElement(root.body, 'channel');
  if (!channel) schema('channel');
  const blocks = elements(channel.body, 'item');
  if (!blocks) schema('item incomplet');
  const header = channel.body.slice(0, blocks[0]?.start ?? channel.body.length);
  if (elementText(header, 'link') !== 'https://status.volcengine.com/') schema('channel');
  const title = elementText(header, 'title');
  const region = title?.match(/^火山引擎火山方舟大模型服务平台\((.+)\)服务状态$/)?.[1] ?? null;
  if (!region || (expectedRegion && REGION[expectedRegion] !== region)) schema('région');
  const items = blocks.map(({ body }) => {
    const title = elementText(body, 'title');
    const description = elementText(body, 'description');
    const pubDate = elementText(body, 'pubDate');
    if (!title || description === null || !pubDate || !Number.isFinite(Date.parse(pubDate)) || elementText(body, 'link') !== 'https://status.volcengine.com/') schema('item');
    return { title, description, pubDate };
  });
  return { region, items };
}

// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'flux RSS Volcengine status', en: 'Volcengine status RSS feeds' };

export async function collect(provider, get) {
  const base = provider.source.url.replace(/\/+$/, '');
  const { product, productLabel, regions = [] } = provider.source;
  // Échec par région capturé ici : une région illisible ne fait pas échouer les autres
  const results = await Promise.all(regions.map(async (r) => {
    try {
      const parsed = parseVolcengineRss(await get(`${base}/rss/zh/${r}/${product}`, { as: 'text', accept: 'application/rss+xml,text/xml' }), r);
      return { id: r, parsed, why: null };
    } catch (err) {
      return { id: r, parsed: null, why: err.message, err };
    }
  }));
  const bad = results.filter((r) => r.why);
  if (bad.length === results.length) {
    // Réseau, HTTP ou timeout partout : l'erreur d'origine garde sa classification
    const first = bad.find((r) => r.err);
    if (first) throw first.err;
    throw fail('schema', bad.map((r) => `${r.id}: rss/zh (channel title)`).join(', '));
  }
  const components = results.map((r) => {
    if (r.why) return { name: `${productLabel} (${r.id})`, status: 'inconnu' };
    // Suffixe en parenthèses ASCII ou pleine chasse : « (已恢复) » ou « （已恢复） »
    const ongoing = r.parsed.items.filter((i) => !/[（(]已恢复[)）]$/.test(i.title.trimEnd()));
    return { name: `${productLabel} (${r.parsed.region})`, status: ongoing.length ? 'degradation' : 'operationnel', ongoing };
  });
  const incidents = components.flatMap((c) => (c.ongoing ?? []).map((i) => ({
    title: i.title,
    state: 'en cours',
    createdAt: i.pubDate && Number.isFinite(Date.parse(i.pubDate)) ? new Date(i.pubDate).toISOString() : null,
    url: `${base}/`,
    components: [c.name],
  })));
  const alerted = components.filter((c) => c.status !== 'operationnel').length;
  const badIds = bad.map((r) => r.id).join(', ');
  return {
    indicator: null,
    rawStatus: alerted ? `${alerted} region(s) with an unresolved event` : `No unresolved event (${components.length} regions)`,
    rawIndicator: alerted ? 'unresolved' : 'none',
    components: components.map(({ name, status }) => ({ name, status })),
    incidents,
    note: bad.length ? `régions illisibles : ${badIds}` : null,
    noteEn: bad.length ? `unreadable regions: ${badIds}` : null,
  };
}
