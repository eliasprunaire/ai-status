import { fail } from '../lib/errors.mjs';
import { STATUS_LIMITS } from '../public/status-contract.js';

// Alibaba Cloud : statut cloud global (pas Qwen ni Model Studio, absents du catalogue de la
// page). La page lit l'en-cours sur /api/status/listEventInProgressInternational ; l'historique
// (/api/status/listHistoryEvent) sert de second filet. Un événement sans fin, ou avec une fin
// dans le futur, est en cours. Le résultat est porté par un composant explicite « événements
// globaux » : jamais de vert sans composant
// Libellé de la famille de source, affiché « Lu via … » par la page
export const METHOD = { fr: 'API Alibaba Cloud', en: 'Alibaba Cloud API' };
export const COMPONENT = 'Alibaba Cloud (événements globaux)';

const validTime = (value) => typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime());

function events(data, route) {
  const list = data?.data;
  if (data?.success !== true || data?.code !== 200 || data?.httpCode !== 200 || !Array.isArray(list) || list.length > STATUS_LIMITS.events) throw fail('schema', route);
  for (const event of list) {
    if (!event || !validTime(event.startTime) || !(event.endTime == null || validTime(event.endTime)) || (event.products != null && (!Array.isArray(event.products) || event.products.length > STATUS_LIMITS.eventComponents))) throw fail('schema', `${route} (event)`);
  }
  return list;
}

export async function collect(provider, get) {
  const base = provider.source.url.replace(/\/+$/, '');
  const [current, history] = await Promise.all([
    get(`${base}/api/status/listEventInProgressInternational`).then((data) => events(data, 'listEventInProgressInternational')),
    get(`${base}/api/status/listHistoryEvent`).then((data) => events(data, 'listHistoryEvent')),
  ]);
  const now = Date.now();
  const seen = new Set();
  const ongoing = [...current, ...history].filter((e) => {
    if (!(e.endTime == null || e.endTime > now)) return false;
    const key = e.id ?? `${e.title}\n${e.startTime}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    indicator: null,
    rawStatus: ongoing.length > 0 ? `${ongoing.length} événement(s) en cours` : 'Aucun incident déclaré (statut cloud global)',
    rawIndicator: ongoing.length > 0 ? 'ALARM' : 'NONE',
    components: [{ name: COMPONENT, status: ongoing.length > 0 ? 'degradation' : 'operationnel' }],
    incidents: ongoing.map((e) => ({
      title: (e.title ?? '').replace(/^\s*\[Incident[^\]]*\]\s*/, '').trim() || 'Événement Alibaba Cloud',
      state: 'en cours',
      createdAt: new Date(e.startTime).toISOString(),
      components: [COMPONENT],
    })),
  };
}
