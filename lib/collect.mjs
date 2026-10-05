// Runner et assemblage du contrat v2 de public/data/status.json.
// Runner : exécute chaque adaptateur en isolant les échecs (réseau, timeout, HTTP,
// schéma) ; c'est le seul endroit qui transforme un échec en état « inconnu ».
// Assemblage : pur, pas de réseau, pas de fichier, testable sur fixtures
import { classifyKind, worstOf, STATUS_LABELS, STATUS_LABELS_EN, STATUSES } from './normalize.mjs';
import { fail, classify } from './errors.mjs';
import { INCIDENT_STATES, isActiveMaintenanceState, MAINTENANCE_STATES, safeExternalUrl, STATUS_LIMITS, summarize, validateStatusDocument } from '../public/status-contract.js';
const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const exceedsProviderLimit = (value) => {
  try {
    return ENCODER.encode(JSON.stringify(value)).byteLength > STATUS_LIMITS.providerBytes;
  } catch {
    return true;
  }
};

// Groupes d'affichage fixes : libellés et ordre côté page (public/app.js), ids validés ici
export const GROUPS = ['us', 'eu', 'cn', 'cloud'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const schema = (field) => { throw fail('schema', `résultat adaptateur (${field})`); };
const text = (value, field, { optional = false, empty = false } = {}) => {
  if (value == null && optional) return null;
  if (typeof value !== 'string' || (!empty && value.length === 0) || value.length > STATUS_LIMITS.string) schema(field);
  return value;
};
const list = (value, field, limit, { optional = false } = {}) => {
  if (value == null && optional) return [];
  if (!Array.isArray(value) || value.length > limit) schema(field);
  return value;
};

function normalizeAdapterResult(provider, raw) {
  let budget = STATUS_LIMITS.providerBytes;
  const spend = (value = '') => {
    budget -= 1 + (typeof value === 'string' ? ENCODER.encode(value).byteLength : 0);
    if (budget < 0) throw fail('limit', 'résultat fournisseur', 'provider result');
    return value;
  };
  const boundedText = (...args) => {
    const value = text(...args);
    return value === null ? null : spend(value);
  };
  const boundedDate = (value, field) => {
    if (value == null) return null;
    boundedText(value, field);
    if (!Number.isFinite(Date.parse(value))) schema(field);
    return new Date(value).toISOString();
  };
  if (!isObject(raw)) schema('objet attendu');
  spend();
  const indicator = raw.indicator ?? null;
  if (indicator !== null && !STATUSES.includes(indicator)) schema('indicator');
  const components = list(raw.components, 'components', STATUS_LIMITS.components).map((component) => {
    spend();
    if (!isObject(component) || !STATUSES.includes(component.status)) schema('components[]');
    return { name: boundedText(component.name, 'components[].name'), status: component.status };
  });
  if (indicator === null && components.length === 0) schema("aucune preuve d'état");

  const incidents = list(raw.incidents, 'incidents', STATUS_LIMITS.events, { optional: true }).map((incident) => {
    spend();
    if (!isObject(incident)) schema('incidents[]');
    return {
      title: boundedText(incident.title, 'incidents[].title'),
      state: INCIDENT_STATES.includes(incident.state) ? spend(incident.state) : schema('incidents[].state'),
      impact: boundedText(incident.impact, 'incidents[].impact', { optional: true, empty: true }),
      createdAt: boundedDate(incident.createdAt, 'incidents[].createdAt'),
      updatedAt: boundedDate(incident.updatedAt, 'incidents[].updatedAt'),
      url: incident.url == null ? null : safeExternalUrl(boundedText(incident.url, 'incidents[].url', { empty: true }), provider.statusUrl, provider.source.kind),
      components: list(incident.components, 'incidents[].components', STATUS_LIMITS.eventComponents, { optional: true })
        .map((name) => boundedText(name, 'incidents[].components[]')),
    };
  });
  const maintenances = list(raw.maintenances, 'maintenances', STATUS_LIMITS.events, { optional: true }).map((maintenance) => {
    spend();
    if (!isObject(maintenance)) schema('maintenances[]');
    return {
      title: boundedText(maintenance.title, 'maintenances[].title'),
      state: MAINTENANCE_STATES.includes(maintenance.state) ? spend(maintenance.state) : schema('maintenances[].state'),
      scheduledFor: boundedDate(maintenance.scheduledFor, 'maintenances[].scheduledFor'),
      scheduledUntil: boundedDate(maintenance.scheduledUntil, 'maintenances[].scheduledUntil'),
      url: maintenance.url == null ? null : safeExternalUrl(boundedText(maintenance.url, 'maintenances[].url', { empty: true }), provider.statusUrl, provider.source.kind),
    };
  });
  const normalized = {
    indicator,
    rawStatus: boundedText(raw.rawStatus, 'rawStatus', { optional: true, empty: true }),
    components,
    incidents,
    maintenances,
    note: boundedText(raw.note, 'note', { optional: true, empty: true }),
    noteEn: boundedText(raw.noteEn, 'noteEn', { optional: true, empty: true }),
    // Facultatif : un adaptateur qui réutilise une observation récente garde son heure d'origine
    collectedAt: boundedDate(raw.collectedAt, 'collectedAt'),
  };
  if (exceedsProviderLimit(normalized)) throw fail('limit', 'résultat fournisseur', 'provider result');
  return normalized;
}

// Lance chaque adaptateur avec le client `get` : un throw devient un rejet capturé
// par allSettled, jamais un plantage de toute la collecte. `adapters` : famille de
// source → module exposant collect(provider, get)
export async function collectAll(providers, adapters, get) {
  return Promise.allSettled(
    providers.map((p) =>
      Promise.resolve().then(() => {
        const adapter = adapters[p.source.kind];
        if (!adapter) throw fail('unknown_kind', p.source.kind);
        const providerGet = (url, options = {}) => get(url, {
          ...options,
          maxBytes: p.source.maxResponseBytes,
          redirectOrigins: p.source.redirectOrigins,
        });
        return adapter.collect(p, providerGet);
      }).then((r) => {
        const normalized = normalizeAdapterResult(p, r);
        // Une heure dans le futur n'est jamais retenue
        const observed = normalized.collectedAt !== null && Date.parse(normalized.collectedAt) <= Date.now() ? normalized.collectedAt : null;
        return { ...normalized, collectedAt: observed ?? new Date().toISOString() };
      })
    )
  );
}

// Phrase courte expliquant le statut, sans texte brut de la source. Deux langues,
// même logique : la page choisit reason (fr) ou reasonEn sans recalculer
const WORDS = {
  fr: {
    notRead: 'source non lue', noIncident: 'aucun incident déclaré', undetermined: 'état non déterminé',
    component: ['composant', 'composants'], tracked: ['composant suivi, aucune alerte', 'composants suivis, aucune alerte'],
    unreadable: ["composant à l'état illisible", "composants à l'état illisible"],
    maintenance: ['maintenance en cours', 'maintenances en cours'], incident: ['incident en cours', 'incidents en cours'],
    inState: (n, status) => `${n} ${WORDS.fr.component[n > 1 ? 1 : 0]} en ${STATUS_LABELS[status].toLowerCase()}`,
    labels: STATUS_LABELS,
    sep: ' : ',
    errors: {
      timeout: 'délai dépassé', http: 'réponse HTTP', network: 'erreur réseau', schema: 'schéma inattendu',
      scope: 'périmètre absent de la source', policy: 'destination refusée', limit: 'réponse trop volumineuse',
      browser: 'erreur navigateur', unknown_kind: 'adaptateur inconnu', unavailable: 'source indisponible',
    },
  },
  en: {
    notRead: 'source not read', noIncident: 'no incident reported', undetermined: 'state not determined',
    component: ['component', 'components'], tracked: ['component tracked, no alert', 'components tracked, no alert'],
    unreadable: ['component with unreadable state', 'components with unreadable state'],
    maintenance: ['maintenance in progress', 'maintenances in progress'], incident: ['incident in progress', 'incidents in progress'],
    inState: (n, status) => `${n} ${WORDS.en.component[n > 1 ? 1 : 0]} ${WORDS.en.labels[status].toLowerCase()}`,
    labels: STATUS_LABELS_EN,
    sep: ': ',
    errors: {
      timeout: 'timed out', http: 'HTTP response', network: 'network error', schema: 'unexpected schema',
      scope: 'scope missing from source', policy: 'destination rejected', limit: 'response too large',
      browser: 'browser error', unknown_kind: 'unknown adapter', unavailable: 'source unavailable',
    },
  },
};

function pluralize(n, forms) {
  return `${n} ${forms[n > 1 ? 1 : 0]}`;
}

export function reasonFor(p, lang = 'fr') {
  const w = WORDS[lang];
  if (p.collect.state === 'error') return w.notRead;
  const alert = p.components.filter((c) => c.status !== 'operationnel' && c.status !== 'inconnu');
  const unknown = p.components.filter((c) => c.status === 'inconnu');
  const inProgress = p.maintenances.filter((m) => m.state === 'in_progress' || m.state === 'verifying');
  if (p.status === 'operationnel') return p.components.length ? pluralize(p.components.length, w.tracked) : w.noIncident;
  if (p.status === 'inconnu') return unknown.length ? pluralize(unknown.length, w.unreadable) : w.undetermined;
  if (p.status === 'maintenance' && inProgress.length) return pluralize(inProgress.length, w.maintenance);
  if (alert.length) return w.inState(alert.length, p.status);
  if (p.incidents.length) return pluralize(p.incidents.length, w.incident);
  return w.labels[p.status];
}

// Texte d'échec : mot du code + détail. Source injoignable : sa note remplace le mot
export function errorText(failure, lang = 'fr') {
  const w = WORDS[lang];
  const word = w.errors[failure.kind] ?? failure.kind;
  const detail = lang === 'en' ? failure.detailEn ?? failure.detail : failure.detail;
  const value = failure.kind === 'unavailable' ? detail ?? word : detail ? `${word}${w.sep}${detail}` : word;
  const string = String(value);
  const limit = Math.min(STATUS_LIMITS.string, STATUS_LIMITS.providerBytes / 4);
  const bytes = ENCODER.encode(string);
  if (bytes.byteLength <= limit) return string;
  return `${DECODER.decode(bytes.subarray(0, limit - 3)).replace(/�$/, '')}…`;
}

export function buildProvider(p, settledResult, adapter = null) {
  const base = { id: p.id, name: p.name, group: p.group ?? null, scope: p.scope ?? null, scopeEn: p.scopeEn ?? null, statusUrl: p.statusUrl };
  const failure = settledResult.status === 'rejected' ? classify(settledResult.reason) : null;
  const r = failure ? { collectedAt: new Date().toISOString() } : settledResult.value;
  const components = (r.components ?? []).map((c) => ({
    name: c.name,
    kind: classifyKind(c.name, p.modelPattern),
    status: STATUSES.includes(c.status) ? c.status : 'inconnu',
  }));
  const incidents = (r.incidents ?? [])
    .map((i) => ({
      title: i.title,
      status: i.state,
      impact: i.impact ?? null,
      startedAt: i.createdAt ?? null,
      updatedAt: i.updatedAt ?? null,
      url: i.url ?? null,
      components: i.components ?? [],
    }));
  const maintenances = (r.maintenances ?? []).map((m) => ({
    title: m.title,
    state: m.state,
    scheduledFor: m.scheduledFor ?? null,
    scheduledUntil: m.scheduledUntil ?? null,
    url: m.url ?? null,
  }));
  // Statut fournisseur = pire de l'indicateur de page (ignoré si la source n'en publie
  // pas), des composants et d'une maintenance en cours. Un composant « inconnu »
  // interdit « operationnel » (règle de worstOf) ; un échec force « inconnu »
  const inProgress = maintenances.some((m) => isActiveMaintenanceState(m.state));
  const incidentStatus = incidents.map((incident) => STATUSES.includes(incident.impact) && incident.impact !== 'operationnel' ? incident.impact : 'degradation');
  const indicator = r.indicator == null ? [] : [STATUSES.includes(r.indicator) ? r.indicator : 'inconnu'];
  const status = failure ? 'inconnu' : worstOf([...indicator, ...components.map((c) => c.status), ...incidentStatus, ...(inProgress ? ['maintenance'] : [])]);
  // Libellé de la famille de source, porté par l'adaptateur ; null sans adaptateur (la page replie sur l'id)
  const method = { method: p.source.kind, methodLabel: adapter?.METHOD?.fr ?? null, methodLabelEn: adapter?.METHOD?.en ?? null };
  const collect = failure
    ? { state: 'error', ...method, error: errorText(failure, 'fr'), errorEn: errorText(failure, 'en') }
    : { state: 'ok', ...method, error: r.note ?? null, errorEn: r.noteEn ?? null };
  const out = {
    ...base,
    status,
    reason: '',
    reasonEn: '',
    sourceText: r.rawStatus ?? null,
    collectedAt: r.collectedAt,
    collect,
    components,
    incidents,
    maintenances,
  };
  out.reason = reasonFor(out, 'fr');
  out.reasonEn = reasonFor(out, 'en');
  if (exceedsProviderLimit(out)) {
    if (!failure) return buildProvider(p, { status: 'rejected', reason: fail('limit', 'résultat fournisseur', 'provider result') }, adapter);
    out.collect.error = errorText({ kind: failure.kind }, 'fr');
    out.collect.errorEn = errorText({ kind: failure.kind }, 'en');
  }
  return out;
}

export function buildOutput(providers, settled, now, adapters = {}) {
  const out = providers.map((p, i) => buildProvider(p, settled[i], adapters[p.source.kind] ?? null));
  const doc = {
    schemaVersion: 2,
    generatedAt: now,
    // Libellés conservés dans le JSON pour la stabilité du contrat ; la page lit les siens dans le module
    labels: STATUS_LABELS,
    labelsEn: STATUS_LABELS_EN,
    summary: summarize(out),
    providers: out,
  };
  if (!validateStatusDocument(doc, providers)) throw fail('schema', 'status.json');
  return doc;
}
