// Lecture de data/status.json (contrat v2, généré par la collecte GitHub Actions).
// Tout texte externe est inséré via textContent (pas d'innerHTML) → aucun contenu
// externe exécuté ou interprété comme instructions
import { DISPLAY_ORDER, isActiveMaintenanceState, MAX_STATUS_BYTES, safeExternalUrl, STATUS_LABELS, STATUS_LABELS_EN, validateStatusDocument } from './status-contract.js';

import { BUILD_INFO } from './build-info.js';

const FRESHNESS_MS = 15 * 1000;
const REFRESH_MS = 30 * 60 * 1000;
const REFRESH_STATUS_MS = 8 * 1000;
const FETCH_TIMEOUT_MS = 15 * 1000;
const STALE_MS = 2 * 60 * 60 * 1000; // 4 cadences de collecte ratées
// Textes de l'interface en deux langues. Le français reste la langue par défaut ; le choix
// est mémorisé dans localStorage (sans dépendance) et appliqué côté client sans requête.
// Les noms propres, titres d'incidents et textes bruts des sources ne sont jamais traduits
const T = {
  fr: {
    title: 'État des fournisseurs IA',
    description: 'Statut opérationnel des principaux fournisseurs de modèles IA, collecté par GitHub Actions et publié en statique.',
    skip: 'Aller à la liste des fournisseurs', brand: 'État des fournisseurs IA', loading: 'Chargement…',
    refresh: 'Rafraîchir', filterByState: 'Filtrer par état', langGroup: 'Langue de la page', langFr: 'Français', langEn: 'Anglais',
    ongoing: 'En cours', controls: 'Recherche et tri', searchPlaceholder: 'Fournisseur, modèle ou service…',
    searchLabel: 'Rechercher un fournisseur, un modèle ou un service', sort: 'Tri', sortSeverity: 'par gravité', sortName: 'par nom',
    all: 'Tous', noResults: 'Aucun fournisseur ne correspond.', resultCount: (n, total) => `${countWord(n, 'fournisseur')} sur ${total}`,
    allOperational: 'Tous les fournisseurs sont opérationnels', noIncident: 'Aucun incident déclaré',
    worstAt: (label, n) => `${label} chez ${countWord(n, 'fournisseur')}`,
    unknownSources: (n) => `${countWord(n, 'source')} non vérifiée${n > 1 ? 's' : ''}`,
    freshness: (refreshed, collected, collectionAge) => `Collecte ${collected}${collectionAge ? ` (${collectionAge})` : ''} · vérifié ${refreshed}`,
    stale: (age) => `Données obsolètes : dernière collecte ${age}. Les états affichés ne reflètent peut-être plus la situation actuelle.`,
    justNow: 'à l’instant', minutesAgo: (n) => `il y a ${n} min`, hoursAgo: (h) => `il y a ${h} h`, daysAgo: (d) => `il y a ${d} j`,
    unavailable: 'Données indisponibles', cannotLoad: 'Impossible de charger les données.',
    refreshing: 'Actualisation en cours…', refreshed: 'Données actualisées.', upToDate: (age) => `Aucune nouvelle collecte publiée${age ? ` : dernière ${age}` : ''}.`, refreshFailed: 'Échec de l’actualisation.',
    refreshError: 'Actualisation impossible : dernières données valides conservées.',
    components: (n) => countWord(n, 'composant'), globalStatus: 'Statut global',
    incidents: 'Incidents', maintenances: 'Maintenances', models: 'Modèles', services: 'Services', componentsTitle: 'Composants',
    since: 'depuis', plannedFor: 'prévue', until: 'jusqu’à', detail: 'détail', maintenanceWord: 'maintenance',
    readVia: 'Lu via', officialPage: 'page officielle',
    providers: (n) => countWord(n, 'fournisseur'), inAlert: (n) => `${n} en alerte`, unverified: (n) => `${n} non vérifié${n > 1 ? 's' : ''}`,
    groups: { us: 'Fournisseurs · USA', eu: 'Fournisseurs · Europe', cn: 'Fournisseurs · Chine', cloud: 'Clouds d’inférence et API', other: 'Autres' },
    groupEmpty: 'Aucune source suivie pour l’instant.',
    incidentStates: { investigating: 'en investigation', identified: 'cause identifiée', monitoring: 'sous surveillance', 'en cours': 'en cours', in_progress: 'en cours', verifying: 'en vérification', scheduled: 'planifiée' },
    footCollect: 'Collecte', footCollectText: 'Toutes les 30 minutes par GitHub Actions. Les données sont publiées avec la page, dans le même déploiement.',
    footRefresh: 'Actualisation', footRefreshText: 'La page recharge les données toutes les 30 minutes, au retour dans un onglet ancien, ou avec le bouton « Rafraîchir ».',
    footRead: 'Lecture', footReadText: 'Chaque ligne dépliée donne le périmètre mesuré, la méthode de lecture, la fraîcheur, les incidents, les composants et la page officielle.',
    footUnknown: 'Non vérifié', footUnknownText: 'La source n’a pas pu être lue. Ce n’est jamais un « opérationnel » par défaut.',
    footAbout: 'À propos de cette page', footSource: 'Code source et méthode par fournisseur',
    locale: 'fr-FR',
  },
  en: {
    title: 'AI provider status',
    description: 'Operational status of the main AI model providers, collected by GitHub Actions and published as a static page.',
    skip: 'Skip to the provider list', brand: 'AI provider status', loading: 'Loading…',
    refresh: 'Refresh', filterByState: 'Filter by state', langGroup: 'Page language', langFr: 'French', langEn: 'English',
    ongoing: 'Ongoing', controls: 'Search and sort', searchPlaceholder: 'Provider, model or service…',
    searchLabel: 'Search a provider, a model or a service', sort: 'Sort', sortSeverity: 'by severity', sortName: 'by name',
    all: 'All', noResults: 'No provider matches.', resultCount: (n, total) => `${countWord(n, 'provider')} of ${total}`,
    allOperational: 'All providers are operational', noIncident: 'No incident reported',
    worstAt: (label, n) => `${label} at ${countWord(n, 'provider')}`,
    unknownSources: (n) => `${countWord(n, 'source')} unverified`,
    freshness: (refreshed, collected, collectionAge) => `Collected ${collected}${collectionAge ? ` (${collectionAge})` : ''} · checked ${refreshed}`,
    stale: (age) => `Stale data: last collection ${age}. The states shown may no longer reflect the current situation.`,
    justNow: 'just now', minutesAgo: (n) => `${n} min ago`, hoursAgo: (h) => `${h} h ago`, daysAgo: (d) => `${d} d ago`,
    unavailable: 'Data unavailable', cannotLoad: 'Unable to load the data.',
    refreshing: 'Refreshing…', refreshed: 'Data refreshed.', upToDate: (age) => `No new collection published${age ? `: last one ${age}` : ''}.`, refreshFailed: 'Refresh failed.',
    refreshError: 'Refresh failed: last valid data kept.',
    components: (n) => countWord(n, 'component'), globalStatus: 'Global status',
    incidents: 'Incidents', maintenances: 'Maintenances', models: 'Models', services: 'Services', componentsTitle: 'Components',
    since: 'since', plannedFor: 'planned for', until: 'until', detail: 'details', maintenanceWord: 'maintenance',
    readVia: 'Read via', officialPage: 'official page',
    providers: (n) => countWord(n, 'provider'), inAlert: (n) => `${n} in alert`, unverified: (n) => `${n} unverified`,
    groups: { us: 'Providers · USA', eu: 'Providers · Europe', cn: 'Providers · China', cloud: 'Inference clouds and APIs', other: 'Others' },
    groupEmpty: 'No source tracked yet.',
    incidentStates: { investigating: 'investigating', identified: 'identified', monitoring: 'monitoring', 'en cours': 'in progress', in_progress: 'in progress', verifying: 'verifying', scheduled: 'scheduled' },
    footCollect: 'Collection', footCollectText: 'Every 30 minutes by GitHub Actions. The data is published with the page, in the same deployment.',
    footRefresh: 'Refresh', footRefreshText: 'The page reloads the data every 30 minutes, when returning to an old tab, or with the “Refresh” button.',
    footRead: 'Reading', footReadText: 'Each expanded row gives the measured scope, the reading method, the freshness, the incidents, the components and the official page.',
    footUnknown: 'Unverified', footUnknownText: 'The source could not be read. It is never an “operational” by default.',
    footAbout: 'About this page', footSource: 'Source code and method per provider',
    locale: 'en-GB',
  },
};
const LANGS = ['fr', 'en'];
// Groupes d'affichage : ordre ; un groupe absent du contrat tombe dans « Autres ».
// « eu » est affiché même sans fournisseur, avec un texte
const GROUPS = ['us', 'eu', 'cn', 'cloud', 'other'];
const ALWAYS_SHOWN = new Set(['eu']);
// Libellés d'état : ceux du contrat, jamais ceux du JSON (champs labels conservés pour la stabilité)
const LABELS = { fr: STATUS_LABELS, en: STATUS_LABELS_EN };

let data = null;
let lang = readLang();
let filter = 'all';
let query = '';
let sortMode = 'severity';
let refreshing = false;
let lastAttemptAt = 0;
let lastRefreshAt = null;
let refreshTimer;

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text != null) e.textContent = text;
  return e;
};
const label = (status) => LABELS[lang][status] ?? status;
const t = (key) => T[lang][key];
function readLang() {
  try { return LANGS.includes(localStorage.getItem('lang')) ? localStorage.getItem('lang') : 'fr'; } catch { return 'fr'; }
}
// Texte généré par le collecteur dans les deux langues (raison, périmètre, note de collecte)
const localized = (fr, en) => (lang === 'en' && en ? en : fr);
const severity = (status) => {
  const i = DISPLAY_ORDER.indexOf(status);
  return i === -1 ? DISPLAY_ORDER.length : i;
};
// État réel = ni opérationnel ni non vérifié : c'est ce qui compte comme alerte
const isAlert = (status) => status !== 'operationnel' && status !== 'inconnu';
// Titres de sources en chinois ou en anglais : lang posé pour les lecteurs d'écran
const langOf = (text) => (/[㐀-鿿]/.test(text) ? 'zh' : 'en');
const bidi = (text, className = null) => {
  const node = el('bdi', className, text);
  node.dir = 'auto';
  node.lang = langOf(text);
  return node;
};
const appendNames = (parent, names) => names.forEach((name, index) => {
  if (index) parent.appendChild(document.createTextNode(', '));
  parent.appendChild(bidi(name));
});

function icon(status) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `ic s-${status}`);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#ic-${status}`);
  svg.appendChild(use);
  return svg;
}

function ageLabel(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return null;
  const min = Math.floor(ms / 60000);
  if (min < 1) return t('justNow');
  if (min < 60) return t('minutesAgo')(min);
  const h = ms / 3600000;
  if (h < 48) return t('hoursAgo')(h < 10 ? h.toFixed(1).replace('.0', '') : Math.round(h));
  return t('daysAgo')(Math.floor(h / 24));
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(T[lang].locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

// Âge relatif rafraîchi toutes les 15 s par renderFreshness via data-age
function ageSpan(iso) {
  const s = el('span', null, ageLabel(iso) ?? '');
  s.dataset.age = iso;
  s.title = fmtDate(iso);
  return s;
}

function sortedProviders() {
  const list = [...(data?.providers ?? [])];
  list.sort((a, b) =>
    sortMode === 'name'
      ? a.name.localeCompare(b.name, lang)
      : severity(a.status) - severity(b.status) || a.name.localeCompare(b.name, lang)
  );
  return list;
}

// Bandeau : pire état réel + compteurs cliquables (les « non vérifiés » ont toujours leur compteur)
function renderSummary() {
  const s = data.summary;
  const overall = $('overall');
  overall.textContent = '';
  overall.appendChild(icon(s.worst));
  const unknown = s.counts.inconnu ?? 0;
  const text = s.worst === 'operationnel'
    ? (unknown ? t('noIncident') : t('allOperational'))
    : t('worstAt')(label(s.worst), data.providers.filter((p) => p.status === s.worst).length);
  overall.appendChild(el('span', null, text));
  if (unknown) overall.appendChild(el('span', 'overall-unknown', t('unknownSources')(unknown)));

  const counts = $('counts');
  counts.textContent = '';
  const all = countButton('all', t('all'), data.providers.length);
  counts.appendChild(all);
  for (const status of DISPLAY_ORDER) {
    const n = s.counts[status] ?? 0;
    if (n > 0) counts.appendChild(countButton(status, label(status), n));
  }
}

function countWord(n, word) {
  return `${n} ${word}${n > 1 ? 's' : ''}`;
}

function countButton(status, text, n) {
  const b = el('button', `chip s-${status}`);
  b.type = 'button';
  b.dataset.status = status;
  b.setAttribute('aria-pressed', String(filter === status));
  if (status !== 'all') b.appendChild(icon(status));
  b.appendChild(el('span', null, `${text} `));
  b.appendChild(el('span', 'count', String(n)));
  b.addEventListener('click', () => {
    filter = filter === status ? 'all' : status;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.status === filter)));
    renderSections();
  });
  return b;
}

function renderFreshness() {
  if (!data) return;
  const at = $('collected-at');
  const refreshedAt = lastRefreshAt ?? data.generatedAt;
  const collectionAge = ageLabel(data.generatedAt);
  at.textContent = t('freshness')(fmtDate(refreshedAt), fmtDate(data.generatedAt), collectionAge);
  const stale = Date.now() - new Date(data.generatedAt).getTime() > STALE_MS;
  const banner = $('stale');
  banner.hidden = !stale;
  banner.textContent = stale ? t('stale')(collectionAge) : '';
  document.querySelectorAll('[data-age]').forEach((e) => {
    e.textContent = ageLabel(e.dataset.age) ?? '';
  });
}

// Section « En cours » : états réels seulement ; les « non vérifiés » ont le bandeau et leur carte
function renderOngoing() {
  const list = $('ongoing-list');
  list.textContent = '';
  const items = [];
  for (const p of sortedProviders()) {
    if (!isAlert(p.status)) continue;
    const li = el('li', `ongoing-item s-${p.status}`);
    li.appendChild(icon(p.status));
    const body = el('div', 'ongoing-body');
    const head = el('p', 'ongoing-head');
    const a = el('a', 'ongoing-provider', p.name);
    a.href = `#${p.id}`;
    head.appendChild(a);
    head.appendChild(el('span', 'ongoing-status', ` · ${label(p.status)} · ${localized(p.reason, p.reasonEn)}`));
    body.appendChild(head);
    const alerted = p.components.filter((c) => c.status !== 'operationnel');
    if (alerted.length) {
      const names = el('p', 'ongoing-comps');
      appendNames(names, alerted.map((c) => c.name));
      body.appendChild(names);
    }
    for (const inc of p.incidents) body.appendChild(incidentLine(inc, p));
    for (const m of p.maintenances.filter((m) => isActiveMaintenanceState(m.state))) body.appendChild(maintenanceLine(m, p));
    li.appendChild(body);
    items.push(li);
  }
  $('ongoing').hidden = items.length === 0;
  for (const li of items) list.appendChild(li);
}

function externalLink(href, text, className, provider) {
  const safeHref = safeExternalUrl(href, provider.statusUrl, provider.collect.method);
  if (!safeHref) return null;
  const a = el('a', className, text);
  a.href = safeHref;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function incidentLine(inc, provider) {
  const p = el('p', 'incident');
  p.appendChild(bidi(inc.title, 'incident-title'));
  const meta = [t('incidentStates')[inc.status] ?? inc.status];
  if (inc.startedAt) meta.push(`${t('since')} ${fmtDate(inc.startedAt)}`);
  const details = el('span', 'incident-meta', ` · ${meta.join(' · ')}`);
  if (inc.components?.length) {
    details.appendChild(document.createTextNode(' · '));
    appendNames(details, inc.components);
  }
  p.appendChild(details);
  const link = inc.url && externalLink(inc.url, t('detail'), 'incident-link', provider);
  if (link) {
    p.appendChild(document.createTextNode(' · '));
    p.appendChild(link);
  }
  return p;
}

function maintenanceLine(m, provider) {
  const p = el('p', 'incident maintenance');
  p.appendChild(bidi(m.title, 'incident-title'));
  const meta = [`${t('maintenanceWord')} ${t('incidentStates')[m.state] ?? m.state}`];
  if (m.scheduledFor) meta.push(`${m.state === 'scheduled' ? t('plannedFor') : t('since')} ${fmtDate(m.scheduledFor)}`);
  if (m.scheduledUntil) meta.push(`${t('until')} ${fmtDate(m.scheduledUntil)}`);
  p.appendChild(el('span', 'incident-meta', ` · ${meta.join(' · ')}`));
  const link = m.url && externalLink(m.url, t('detail'), 'incident-link', provider);
  if (link) {
    p.appendChild(document.createTextNode(' · '));
    p.appendChild(link);
  }
  return p;
}

function componentList(title, comps) {
  const frag = document.createDocumentFragment();
  frag.appendChild(el('h4', 'sub', `${title} (${comps.length})`));
  const ul = el('ul', 'complist');
  const sorted = [...comps].sort((a, b) => severity(a.status) - severity(b.status) || a.name.localeCompare(b.name, lang));
  for (const c of sorted) {
    const li = el('li', `comp s-${c.status}`);
    li.appendChild(icon(c.status));
    li.appendChild(bidi(c.name, 'comp-name'));
    li.appendChild(el('span', 'comp-status', label(c.status)));
    ul.appendChild(li);
  }
  frag.appendChild(ul);
  return frag;
}

// Ligne compacte, sans élément interactif dans <summary> : icône, nom (h3), état,
// nombre de composants (ou « Statut global » quand la source n'en publie aucun), raison
// hors opérationnel. L'état est toujours annoncé aux lecteurs d'écran
function cardSummary(p) {
  const summary = el('summary', 'card-line');
  summary.appendChild(icon(p.status));
  const head = el('div', 'card-head');
  head.appendChild(el('h3', 'card-name', p.name));
  const scope = localized(p.scope, p.scopeEn);
  if (scope) head.appendChild(el('p', 'card-scope', scope));
  summary.appendChild(head);
  summary.appendChild(el('span', 'card-count', p.components.length ? t('components')(p.components.length) : t('globalStatus')));
  summary.appendChild(el('span', 'card-state', label(p.status)));
  if (p.status !== 'operationnel') summary.appendChild(el('p', 'card-reason', localized(p.reason, p.reasonEn)));
  return summary;
}

// Contenu déplié : tout ce que la carte fermée ne montre pas, lien officiel compris
function cardBody(p) {
  const body = el('div', 'card-body');
  // Note de collecte : texte technique du collecteur, en français sauf traduction fournie
  if (p.collect.error) {
    const err = el('p', 'err', localized(p.collect.error, p.collect.errorEn));
    if (lang !== 'fr' && !p.collect.errorEn) err.lang = 'fr';
    body.appendChild(err);
  }
  if (p.incidents.length) {
    body.appendChild(el('h4', 'sub', t('incidents')));
    for (const inc of p.incidents) body.appendChild(incidentLine(inc, p));
  }
  if (p.maintenances.length) {
    body.appendChild(el('h4', 'sub', t('maintenances')));
    for (const m of p.maintenances) body.appendChild(maintenanceLine(m, p));
  }
  const models = p.components.filter((c) => c.kind === 'model');
  const services = p.components.filter((c) => c.kind !== 'model');
  if (models.length) body.appendChild(componentList(t('models'), models));
  if (services.length) body.appendChild(componentList(models.length ? t('services') : t('componentsTitle'), services));
  const meta = el('p', 'meta');
  // Libellé de la famille de source fourni par le collecteur ; repli sur l'id machine
  meta.appendChild(document.createTextNode(`${t('readVia')} ${localized(p.collect.methodLabel, p.collect.methodLabelEn) ?? p.collect.method} · `));
  meta.appendChild(ageSpan(p.collectedAt));
  const official = externalLink(p.statusUrl, t('officialPage'), null, p);
  if (official) {
    meta.appendChild(document.createTextNode(' · '));
    meta.appendChild(official);
  }
  body.appendChild(meta);
  return body;
}

function makeCard(p) {
  const card = el('article', `card s-${p.status}`);
  card.id = p.id;
  card.dataset.status = p.status;
  const details = el('details');
  details.appendChild(cardSummary(p));
  details.appendChild(cardBody(p));
  card.appendChild(details);
  return card;
}

function matches(p, q) {
  if (!q) return true;
  if (p.name.toLowerCase().includes(q)) return true;
  if (p.components.some((c) => c.name.toLowerCase().includes(q))) return true;
  return p.incidents.some((i) => i.title.toLowerCase().includes(q));
}

function groupMeta(list) {
  const parts = [t('providers')(list.length)];
  const alerts = list.filter((p) => isAlert(p.status)).length;
  const unknown = list.filter((p) => p.status === 'inconnu').length;
  if (alerts) parts.push(t('inAlert')(alerts));
  if (unknown) parts.push(t('unverified')(unknown));
  return parts.join(' · ');
}

// Une section par groupe, dans l'ordre de GROUPS ; le tri choisi est conservé dans chaque section
function renderSections() {
  const main = $('providers');
  main.textContent = '';
  const q = query.trim().toLowerCase();
  const visible = sortedProviders().filter((p) => (filter === 'all' || p.status === filter) && matches(p, q));
  $('result-count').textContent = visible.length === data.providers.length ? '' : t('resultCount')(visible.length, data.providers.length);
  if (visible.length === 0) {
    main.appendChild(el('p', 'noresults', t('noResults')));
    return;
  }
  const known = new Set(GROUPS);
  const unfiltered = filter === 'all' && !q;
  for (const g of GROUPS) {
    const list = visible.filter((p) => (known.has(p.group) ? p.group : 'other') === g);
    if (!list.length && !(ALWAYS_SHOWN.has(g) && unfiltered)) continue;
    const section = el('section', 'group');
    section.setAttribute('aria-labelledby', `g-${g}`);
    const head = el('div', 'group-head');
    const h = el('h2', 'group-title', t('groups')[g]);
    h.id = `g-${g}`;
    head.appendChild(h);
    if (list.length) head.appendChild(el('p', 'group-meta', groupMeta(list)));
    section.appendChild(head);
    if (list.length) {
      const grid = el('div', 'grid');
      for (const p of list) grid.appendChild(makeCard(p));
      section.appendChild(grid);
    } else {
      section.appendChild(el('p', 'group-empty', t('groupEmpty')));
    }
    main.appendChild(section);
  }
}

// Les cartes sont reconstruites à chaque rendu : on mémorise celles qui sont dépliées
const captureOpenCards = () => [...document.querySelectorAll('.card details[open]')].map((details) => details.closest('.card')?.id);
const restoreOpenCards = (ids) => {
  for (const id of ids) document.querySelector(`#${CSS.escape(id)} details`)?.setAttribute('open', '');
};

function renderAll() {
  renderSummary();
  renderOngoing();
  renderSections();
  renderFreshness();
}

function resetUnavailable() {
  data = null;
  $('overall').textContent = t('unavailable');
  $('collected-at').textContent = t('cannotLoad');
  $('counts').textContent = '';
  $('ongoing').hidden = true;
  $('ongoing-list').textContent = '';
  $('providers').textContent = '';
  $('result-count').textContent = '';
  $('stale').hidden = true;
  $('stale').textContent = '';
}

async function readStatusJson(response) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_STATUS_BYTES) throw new Error('données trop volumineuses');
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > MAX_STATUS_BYTES) throw new Error('données trop volumineuses');
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_STATUS_BYTES) {
      await reader.cancel();
      throw new Error('données trop volumineuses');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

// Retour visible du bouton : sans lui, un rechargement sans nouvelle collecte ne change rien à l'écran
let statusTimer;
function showRefreshStatus(text, autoClear = true) {
  const status = $('refresh-status');
  status.textContent = text;
  clearTimeout(statusTimer);
  if (autoClear) statusTimer = setTimeout(() => { status.textContent = ''; }, REFRESH_STATUS_MS);
}

async function refreshData(source) {
  if (refreshing) return;
  refreshing = true;
  lastAttemptAt = Date.now();
  scheduleRefresh(REFRESH_MS);
  const button = $('refresh');
  const error = $('refresh-error');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (source === 'manual') showRefreshStatus(t('refreshing'), false);

  try {
    const res = await fetch('data/status.json', { cache: 'no-store', signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const nextData = await readStatusJson(res);
    if (!validateStatusDocument(nextData)) throw new Error('format de données inattendu');
    if (data && Date.parse(nextData.generatedAt) < Date.parse(data.generatedAt)) throw new Error('données plus anciennes que celles affichées');

    const changed = !data || nextData.generatedAt !== data.generatedAt;
    if (changed) {
      const previousData = data;
      const openCards = captureOpenCards();
      data = nextData;
      try {
        renderAll();
        restoreOpenCards(openCards);
      } catch (renderError) {
        data = previousData;
        if (previousData) {
          try {
            renderAll();
            restoreOpenCards(openCards);
          } catch {
            resetUnavailable();
          }
        } else {
          resetUnavailable();
        }
        throw renderError;
      }
    }

    lastRefreshAt = new Date().toISOString();
    renderFreshness();
    error.hidden = true;
    error.textContent = '';
    if (source === 'manual') showRefreshStatus(changed ? t('refreshed') : t('upToDate')(ageLabel(data.generatedAt)));
  } catch {
    if (!data) resetUnavailable();
    error.textContent = t('refreshError');
    error.hidden = false;
    if (source === 'manual') showRefreshStatus(t('refreshFailed'));
  } finally {
    clearTimeout(timeout);
    refreshing = false;
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
  }
}

function refreshIfDue() {
  const remaining = REFRESH_MS - (Date.now() - lastAttemptAt);
  if (remaining <= 0) refreshData('automatic');
  else scheduleRefresh(remaining);
}

function scheduleRefresh(delay) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refreshIfDue, delay);
}

// Textes statiques de index.html : data-i18n (texte), data-i18n-aria (aria-label),
// data-i18n-placeholder ; document.lang, <title> et description suivent la langue
function applyLang() {
  document.documentElement.lang = lang;
  document.title = t('title');
  document.querySelector('meta[name="description"]')?.setAttribute('content', t('description'));
  document.querySelectorAll('[data-i18n]').forEach((e) => { e.textContent = t(e.dataset.i18n); });
  document.querySelectorAll('[data-i18n-aria]').forEach((e) => e.setAttribute('aria-label', t(e.dataset.i18nAria)));
  document.querySelectorAll('[data-i18n-placeholder]').forEach((e) => { e.placeholder = t(e.dataset.i18nPlaceholder); });
  document.querySelectorAll('.lang-btn').forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    b.setAttribute('aria-label', t(b.dataset.lang === 'fr' ? 'langFr' : 'langEn'));
  });
}

// Changement de langue : instantané, sans requête ; filtres, recherche, tri et cartes
// ouvertes sont conservés. Les messages d'actualisation restent ceux de la dernière action
function setLang(next) {
  if (!LANGS.includes(next) || next === lang) return;
  lang = next;
  try { localStorage.setItem('lang', lang); } catch {}
  applyLang();
  if (!$('refresh-error').hidden) $('refresh-error').textContent = t('refreshError');
  if (!data) {
    if ($('refresh-error').hidden) $('overall').textContent = t('loading');
    else resetUnavailable();
    return;
  }
  const openCards = captureOpenCards();
  renderAll();
  restoreOpenCards(openCards);
}

document.querySelectorAll('.lang-btn').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
applyLang();
$('build-version').textContent = `${BUILD_INFO.version} · ${BUILD_INFO.sha.slice(0, 7)}`;
$('build-version').href = `https://github.com/eliasprunaire/ai-status/commit/${BUILD_INFO.sha}`;

$('search').addEventListener('input', (e) => {
  query = e.target.value;
  renderSections();
});
$('sort').addEventListener('change', (e) => {
  sortMode = e.target.value;
  renderOngoing();
  renderSections();
});
$('refresh').addEventListener('click', () => refreshData('manual'));
window.addEventListener('online', () => refreshData('automatic'));
window.addEventListener('focus', refreshIfDue);
window.addEventListener('pageshow', refreshIfDue);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshIfDue();
});
setInterval(renderFreshness, FRESHNESS_MS);
refreshData('startup');
