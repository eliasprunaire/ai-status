// Tests légers sans framework : node test/test.mjs
// Aucun accès réseau, aucune lecture de fichier généré : tout passe par des fixtures
// réelles capturées dans test/fixtures/
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { normalizeIndicator, normalizeComponentStatus, normalizeGoogleImpact, worstOf, classifyKind, STATUSES, STATUS_LABELS, STATUS_LABELS_EN } from '../lib/normalize.mjs';
import { collectAll, buildOutput, buildProvider, GROUPS } from '../lib/collect.mjs';
import { HttpError, fail } from '../lib/errors.mjs';
import { get as httpGet } from '../lib/http.mjs';
import { attribute, elements } from '../lib/markup.mjs';
import * as statuspage from '../adapters/statuspage.mjs';
import * as alibaba from '../adapters/alibaba.mjs';
import * as google from '../adapters/google.mjs';
import * as flashcat from '../adapters/flashcat.mjs';
import * as unavailable from '../adapters/unavailable.mjs';
import * as xai from '../adapters/xai.mjs';
import * as instatus from '../adapters/instatus.mjs';
import { instatusComponentStatus } from '../adapters/instatus.mjs';
import * as betterstack from '../adapters/betterstack.mjs';
import * as checkly from '../adapters/checkly.mjs';
import * as onlineornot from '../adapters/onlineornot.mjs';
import { decodeTurboStream, parseOnlineornotHtml } from '../adapters/onlineornot.mjs';
import * as aws from '../adapters/aws.mjs';
import { awsCode } from '../adapters/aws.mjs';
import * as azure from '../adapters/azure.mjs';
import { parseAzureRows } from '../adapters/azure.mjs';
import * as tencent from '../adapters/tencent.mjs';
import * as volcengine from '../adapters/volcengine.mjs';
import { parseVolcengineRss } from '../adapters/volcengine.mjs';
import { DISPLAY_ORDER, MAX_STATUS_BYTES, STATUS_LIMITS, safeExternalUrl, summarize, validateStatusDocument } from '../public/status-contract.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const fixtureText = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
// Stubs du client `get` : corps déjà décodé, HttpError hors 2xx, comme lib/http.mjs
const okJson = (body) => async () => body;
const okText = okJson;
const httpFail = (status) => async (url) => { throw new HttpError(status, url); };
const byUrl = (map) => async (url) => {
  const key = Object.keys(map).find((k) => url.includes(k));
  if (!key) throw new HttpError(404, url);
  return map[key];
};
const byUrlText = byUrl;
const byUrlBytes = byUrl;
// Réponse binaire : encodage UTF-16 avec BOM (comme le vrai currentevents AWS) ou UTF-8 avec BOM
const utf16 = (obj) => { const s = JSON.stringify(obj); const b = new Uint8Array(2 + s.length * 2); b[0] = 0xfe; b[1] = 0xff; for (let i = 0; i < s.length; i++) { b[2 + i * 2] = s.charCodeAt(i) >> 8; b[3 + i * 2] = s.charCodeAt(i) & 0xff; } return b; };
const utf8bom = (obj) => new TextEncoder().encode('﻿' + JSON.stringify(obj));
const failing = async () => { throw new Error('ECONNREFUSED'); };
const aborting = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
// Lecture d'un fournisseur par le seam complet : runner (isolation, horodatage) puis contrat
const read = async (mod, p, get) => buildProvider(p, (await collectAll([p], { [p.source.kind]: mod }, get))[0], mod);
const names = (components) => components.map((c) => c.name);
const impacted = (components) => components.filter((c) => c.status !== 'operationnel').map((c) => c.name);

const provider = {
  id: 'test', name: 'Test', statusUrl: 'https://ex.com',
  source: { kind: 'statuspage', url: 'https://ex.com' },
};

// 1. Normalisation.
assert.strictEqual(normalizeIndicator('none'), 'operationnel');
assert.strictEqual(normalizeIndicator('minor'), 'degradation');
assert.strictEqual(normalizeIndicator('major'), 'incident_majeur');
assert.strictEqual(normalizeIndicator('critical'), 'indisponible');
assert.strictEqual(normalizeIndicator('maintenance'), 'maintenance');
assert.strictEqual(normalizeIndicator('inexistant'), 'inconnu');
assert.strictEqual(normalizeComponentStatus('operational'), 'operationnel');
assert.strictEqual(normalizeComponentStatus('partial_outage'), 'degradation');
assert.strictEqual(normalizeComponentStatus('major_outage'), 'incident_majeur');
assert.strictEqual(normalizeComponentStatus('under_maintenance'), 'maintenance');
assert.strictEqual(normalizeComponentStatus('autre'), 'inconnu');
assert.strictEqual(normalizeGoogleImpact('SERVICE_OUTAGE'), 'incident_majeur');
assert.strictEqual(normalizeGoogleImpact('SERVICE_DISRUPTION'), 'degradation');
assert.strictEqual(normalizeGoogleImpact('SERVICE_INFORMATION'), null);
assert.strictEqual(normalizeGoogleImpact('NOUVEL_IMPACT'), 'inconnu');

// 2. worstOf : le pire l'emporte ; un inconnu interdit le vert mais n'écrase pas un état réel.
assert.strictEqual(worstOf([]), 'operationnel');
assert.strictEqual(worstOf(['operationnel', 'maintenance', 'degradation']), 'degradation');
assert.strictEqual(worstOf(['degradation', 'incident_majeur']), 'incident_majeur');
assert.strictEqual(worstOf(['operationnel', 'inconnu']), 'inconnu');
assert.strictEqual(worstOf(['degradation', 'inconnu']), 'degradation');
assert.strictEqual(worstOf(['__proto__']), 'inconnu', 'une propriété héritée n’est jamais un statut');
assert.strictEqual(attribute(' version = \'2.0\' ', 'version'), '2.0');
assert.strictEqual(attribute(' data-version="2.0" ', 'version'), null, 'un attribut préfixé ne remplace pas la clé exacte');
assert.strictEqual(attribute(' version="2.0" version="1.0" ', 'version'), null, 'un attribut dupliqué est ambigu');
assert.strictEqual(attribute(' version="junk version="2.0" " ', 'version'), null, 'un attribut imbriqué dans une valeur malformée est refusé');
assert.strictEqual(attribute(" version='junk version='2.0' ' ", 'version'), null, 'le refus vaut aussi avec des apostrophes');
const hostileAttributes = ' class="x"X'.repeat(20_000);
const attributeStartedAt = performance.now();
assert.strictEqual(attribute(hostileAttributes, 'class', { caseInsensitive: true }), null);
assert.ok(performance.now() - attributeStartedAt < 1_000, 'les quasi-attributs sont lus sans coût quadratique');
assert.strictEqual(elements(`${'<a>'.repeat(2_049)}${'</a>'.repeat(2_049)}`, 'item'), null, 'la profondeur XML est bornée');

// 2b. classifyKind : espace de noms ou motif déclaré ; sinon service. Listes réelles.
const groqPattern = '^(llama|whisper|\\S+/\\S+$)';
assert.strictEqual(classifyKind('meta-llama/llama-4-scout-17b-16e-instruct', groqPattern), 'model');
assert.strictEqual(classifyKind('Website', groqPattern), 'service');
assert.strictEqual(classifyKind('llama-3.3-70b-versatile', groqPattern), 'model');
assert.strictEqual(classifyKind('API', groqPattern), 'service');
assert.strictEqual(classifyKind('Connectors/Apps'), 'service', 'sans motif déclaré, jamais modèle');
assert.strictEqual(classifyKind('embeddings', '^(command|c4ai|embed-|rerank|tiny-aya)'), 'service');
assert.strictEqual(classifyKind('embed-v4.0', '^(command|c4ai|embed-|rerank|tiny-aya)'), 'model');
assert.strictEqual(classifyKind('K2 Model', 'Model$'), 'model');
assert.strictEqual(classifyKind('Open API', 'Model$'), 'service');
assert.strictEqual(classifyKind('Claude API'), 'service');
assert.strictEqual(classifyKind('Claude Code'), 'service');

// 3. Runner : tout échec (réseau, HTTP, timeout, schéma, famille inconnue) → inconnu,
// state error, texte FR et EN par code. Un seul jeu de tests pour tous les adaptateurs
const s1 = await read(statuspage, provider, failing);
assert.strictEqual(s1.status, 'inconnu');
assert.strictEqual(s1.collect.state, 'error');
assert.strictEqual(s1.collect.error, 'erreur réseau : ECONNREFUSED');
assert.strictEqual(s1.collect.errorEn, 'network error: ECONNREFUSED');
const s2 = await read(statuspage, provider, httpFail(500));
assert.strictEqual(s2.status, 'inconnu');
assert.strictEqual(s2.collect.error, 'réponse HTTP : 500 (https://ex.com/api/v2/summary.json)');
assert.strictEqual(s2.collect.errorEn, 'HTTP response: 500 (https://ex.com/api/v2/summary.json)');
const s3 = await read(statuspage, provider, okJson({ foo: 1 }));
assert.strictEqual(s3.status, 'inconnu');
assert.strictEqual(s3.collect.error, 'schéma inattendu : summary.json (status.indicator / components / incidents / scheduled_maintenances)');
assert.strictEqual(s3.collect.errorEn, 'unexpected schema: summary.json (status.indicator / components / incidents / scheduled_maintenances)');
const s3b = await read(statuspage, provider, aborting);
assert.strictEqual(s3b.collect.error, 'délai dépassé');
assert.strictEqual(s3b.collect.errorEn, 'timed out');
const s3c = await read({ collect: async () => { throw fail('scope', 'X'); } }, provider, okJson({}));
assert.strictEqual(s3c.collect.error, 'périmètre absent de la source : X');
assert.strictEqual(s3c.reason, 'source non lue');
const s3f = await read(unavailable, { ...provider, source: { kind: 'unavailable', url: 'https://ex.com' } }, okJson({}));
assert.strictEqual(s3f.collect.error, 'source indisponible', 'sans note : le mot du code');
assert.strictEqual(s3f.collect.errorEn, 'source unavailable');
// Un adaptateur qui rend un résultat n'a plus de mot à dire sur l'échec : sans note, error null
const s3d = await read({ collect: async () => ({ indicator: 'operationnel', components: [] }) }, provider, okJson({}));
assert.deepStrictEqual(s3d.collect, { state: 'ok', method: 'statuspage', methodLabel: null, methodLabelEn: null, error: null, errorEn: null }, 'sans METHOD : libellés null, la page replie sur l’id');
// Note non fatale : state ok, texte dans error / errorEn
const s3e = await read({ collect: async () => ({ indicator: 'operationnel', components: [], note: 'n', noteEn: 'n-en' }) }, provider, okJson({}));
assert.deepStrictEqual(s3e.collect, { state: 'ok', method: 'statuspage', methodLabel: null, methodLabelEn: null, error: 'n', errorEn: 'n-en' });
assert.strictEqual(s3e.status, 'operationnel');

// 3b. Statuspage : fixture réelle Anthropic, tout operational → 6 composants, aucun impacté.
const anthropic = fixture('statuspage-summary-anthropic.json');
const s4 = await read(statuspage, provider, okJson(anthropic));
assert.strictEqual(s4.status, 'operationnel');
assert.strictEqual(s4.components.length, 6);
assert.deepStrictEqual(impacted(s4.components), []);
assert.deepStrictEqual(s4.incidents, []);
assert.deepStrictEqual(s4.maintenances, []);
assert.strictEqual(s4.collect.state, 'ok');
assert.strictEqual(s4.collect.methodLabel, 'API Statuspage');
assert.strictEqual(s4.collect.methodLabelEn, 'Statuspage API');

// 3c. Statuspage : composant dégradé + groupe (ignoré) + incident actif + maintenance en cours.
const s5 = await read(statuspage, provider, okJson({
  status: { indicator: 'minor', description: 'Partial degradation' },
  components: [
    { name: 'API', status: 'degraded_performance' },
    { name: 'Modèles', status: 'degraded_performance', group: true },
    { name: 'Console', status: 'operational' },
  ],
  incidents: [
    { name: 'Elevated errors', status: 'monitoring', impact: 'minor', created_at: '2026-09-03T10:00:00Z', shortlink: 'https://stspg.io/x', components: [{ name: 'API' }] },
    { name: 'Old incident', status: 'resolved' },
  ],
  scheduled_maintenances: [
    { name: 'DB upgrade', status: 'in_progress', scheduled_for: '2026-09-03T09:00:00Z', scheduled_until: null },
    { name: 'Old', status: 'completed' },
  ],
}));
assert.strictEqual(s5.status, 'degradation');
assert.deepStrictEqual(names(s5.components), ['API', 'Console']);
assert.deepStrictEqual(impacted(s5.components), ['API']);
assert.strictEqual(s5.incidents.length, 1);
assert.strictEqual(s5.incidents[0].status, 'monitoring');
assert.deepStrictEqual(s5.incidents[0].components, ['API']);
assert.strictEqual(s5.maintenances.length, 1);

// 3d. Statuspage : indicateur none mais maintenance en cours → maintenance, jamais vert.
const s6 = await read(statuspage, provider, okJson({
  status: { indicator: 'none' }, components: [{ name: 'API', status: 'operational' }],
  incidents: [],
  scheduled_maintenances: [{ name: 'M', status: 'in_progress' }],
}));
assert.strictEqual(s6.status, 'maintenance');
const s7 = await read(statuspage, provider, okJson({
  status: { indicator: 'none' }, components: [{ name: 'API', status: 'under_maintenance' }],
  incidents: [], scheduled_maintenances: [],
}));
assert.strictEqual(s7.status, 'maintenance');
assert.deepStrictEqual(impacted(s7.components), ['API']);
assert.strictEqual((await read(statuspage, provider, okJson({ status: { indicator: 'none' }, components: [{ name: 'API', status: 'operational' }], incidents: [{ name: 'X', status: 'invented' }], scheduled_maintenances: [] }))).status, 'inconnu');
assert.strictEqual((await read(statuspage, provider, okJson({ status: { indicator: 'none' }, components: [{ name: 'API', status: 'operational' }], incidents: [], scheduled_maintenances: [{ name: 'X', status: 'invented' }] }))).status, 'inconnu');
assert.strictEqual((await read(statuspage, provider, okJson({ status: { indicator: 'none' }, components: [{ name: 'API', status: 'operational' }] }))).status, 'inconnu', 'tableaux d’événements absents (émulation incident.io) : jamais vert');
const sMajor = await read(statuspage, provider, okJson({ status: { indicator: 'minor' }, components: [{ name: 'API', status: 'operational' }], incidents: [{ name: 'X', status: 'identified', impact: 'major', components: [] }], scheduled_maintenances: [] }));
assert.strictEqual(sMajor.status, 'incident_majeur', 'impact « major » d’un incident : incident majeur, plus une simple dégradation');
assert.strictEqual(sMajor.incidents[0].impact, 'incident_majeur');
assert.strictEqual((await read(statuspage, provider, okJson({ status: { indicator: 'none' }, components: [{ name: 'API', status: 'operational' }], incidents: {} }))).status, 'inconnu', 'un tableau présent mais mal formé reste rejeté');

// 4. Google : flux officiels, périmètre par préfixe.
const gProvider = { ...provider, statusUrl: 'https://status.cloud.google.com', source: { kind: 'google', url: 'https://status.cloud.google.com', productPrefixes: ['Vertex', 'Gemini'] } };
const products = fixture('google-products.json');
assert.ok(products.products.some((p) => p.title === 'Vertex Gemini API'), 'produit du périmètre attendu dans la fixture');
const g1 = await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': fixture('google-incidents-ia.json') }));
assert.strictEqual(g1.status, 'operationnel', 'fixture : incidents tous terminés');
assert.ok(g1.components.length >= 20 && g1.components.every((c) => /^(Vertex|Gemini)/.test(c.name)), 'composants = produits du périmètre');
assert.deepStrictEqual(impacted(g1.components), []);
assert.ok(/Aucun incident déclaré/.test(g1.sourceText));
const openOn = (title, impact, affectedTitle = title, catalogue = products) => {
  const product = catalogue.products.find((item) => item.title === title);
  assert.ok(product, `produit de test absent : ${title}`);
  return [{ id: 'abc', external_desc: 'Test', begin: '2026-09-03T10:00:00+00:00', end: null, status_impact: impact, uri: 'incidents/abc', affected_products: [{ id: product.id, title: affectedTitle }] }];
};
const g2 = await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': openOn('Vertex Gemini API', 'SERVICE_DISRUPTION') }));
assert.strictEqual(g2.status, 'degradation');
assert.deepStrictEqual(impacted(g2.components), ['Vertex Gemini API']);
assert.strictEqual(g2.incidents[0].url, 'https://status.cloud.google.com/incidents/abc');
const g3 = await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': openOn('Vertex AI Training', 'SERVICE_OUTAGE') }));
assert.strictEqual(g3.status, 'incident_majeur');
const productsWithSql = { products: [...products.products, { id: 'cloud-sql', title: 'Cloud SQL' }] };
const g4 = await read(google, gProvider, byUrl({ 'products.json': productsWithSql, 'incidents.json': openOn('Cloud SQL', 'SERVICE_OUTAGE', 'Cloud SQL', productsWithSql) }));
assert.strictEqual(g4.status, 'operationnel', 'hors périmètre : ignoré');
const g5 = await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': openOn('Vertex Gemini API', 'SERVICE_INFORMATION') }));
assert.strictEqual(g5.status, 'operationnel', 'informatif : ignoré');
const g6 = await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': openOn('Vertex Gemini API', 'NOUVEL_IMPACT') }));
assert.strictEqual(g6.status, 'inconnu', 'impact actif inconnu : jamais vert');
const g7 = await read(google, gProvider, byUrl({ 'products.json': products }));
assert.strictEqual(g7.status, 'inconnu', 'un des deux flux en échec → inconnu');
const g8 = await read(google, { ...gProvider, source: { ...gProvider.source, productPrefixes: ['Inexistant'] } }, byUrl({ 'products.json': products, 'incidents.json': [] }));
assert.strictEqual(g8.status, 'inconnu');
assert.ok(/Inexistant/.test(g8.collect.error));
const g9 = await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': openOn('Vertex Gemini API', 'SERVICE_DISRUPTION', 'Nom public renommé') }));
assert.deepStrictEqual(impacted(g9.components), ['Vertex Gemini API'], 'le rattachement suit l’id stable, pas le libellé incident');
for (const badIncident of [
  { ...openOn('Vertex Gemini API', 'SERVICE_DISRUPTION')[0], end: 'jamais' },
  { ...openOn('Vertex Gemini API', 'SERVICE_DISRUPTION')[0], affected_products: [{ title: 'Vertex Gemini API' }] },
  { ...openOn('Vertex Gemini API', 'SERVICE_DISRUPTION')[0], affected_products: [{ id: 'inconnu', title: 'Vertex Gemini API' }] },
  { ...openOn('Vertex Gemini API', 'SERVICE_DISRUPTION')[0], id: null },
]) {
  assert.strictEqual((await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': [badIncident] }))).status, 'inconnu');
}
assert.strictEqual((await read(google, gProvider, byUrl({ 'products.json': products, 'incidents.json': Array(STATUS_LIMITS.events + 1).fill(openOn('Vertex Gemini API', 'SERVICE_DISRUPTION')[0]) }))).status, 'inconnu', 'les incidents sont bornés avant toute jointure');

// 5. Flashcat (DeepSeek) : fixture réelle, aucun changement actif → operationnel.
const fProvider = { ...provider, statusUrl: 'https://status.deepseek.com', source: { kind: 'flashcat', url: 'https://status.deepseek.com', pageId: '6410630422455' } };
const f1 = await read(flashcat, fProvider, okJson(fixture('flashcat-deepseek-active.json')));
assert.strictEqual(f1.status, 'operationnel');
assert.strictEqual(f1.components.length, 8);
assert.strictEqual(f1.collect.state, 'ok');
// 5b. Payload vide, sans composants, ou 200 inattendu → jamais vert.
for (const body of [{}, { data: {} }, { data: { page: { components: [] }, active_changes: [] } }, { data: { page: { components: [{ name: 'x' }] } } }]) {
  const f = await read(flashcat, fProvider, okJson(body));
  assert.strictEqual(f.status, 'inconnu', `payload ${JSON.stringify(body)}`);
}
const f2 = await read(flashcat, fProvider, httpFail(404));
assert.strictEqual(f2.status, 'inconnu');
// 5c. Un changement actif → degradation avec son titre, services à l'état illisible.
const f3 = await read(flashcat, fProvider, okJson({ data: { page: { components: [{ name: 'API' }] }, active_changes: [{ title: 'API errors' }] } }));
assert.strictEqual(f3.status, 'degradation');
assert.strictEqual(f3.incidents[0].title, 'API errors');
assert.strictEqual(f3.components[0].status, 'inconnu');

// 6. Alibaba : fixture réelle (tout récupéré) → operationnel, incidents vides ; un en cours → degradation.
const a1 = await read(alibaba, provider, okJson(fixture('alibaba-events.json')));
assert.strictEqual(a1.status, 'operationnel');
assert.deepStrictEqual(a1.incidents, []);
const a2 = await read(alibaba, provider, okJson({ success: true, code: 200, httpCode: 200, data: [{ id: 2, title: '[Incident] Bar', startTime: Date.now() - 3600000, endTime: null }] }));
assert.strictEqual(a2.status, 'degradation');
assert.strictEqual(a2.incidents[0].status, 'en cours');
assert.strictEqual(a2.incidents[0].title, 'Bar');
const a3 = await read(alibaba, provider, okJson({ success: true, code: 200, httpCode: 200, data: 'oops' }));
assert.strictEqual(a3.status, 'inconnu');
assert.strictEqual((await read(alibaba, provider, okJson({ success: false, code: 200, httpCode: 200, data: [] }))).status, 'inconnu', 'une enveloppe d’échec ne prouve pas un état sain');
assert.strictEqual((await read(alibaba, provider, okJson({ success: true, code: 200, httpCode: 200, data: [{ title: 'X', startTime: Date.now(), endTime: 'jamais' }] }))).status, 'inconnu', 'une fin invalide ne masque pas un événement');

// 7. xAI : le RSS officiel est un historique d'incidents (fixture réelle du 2026-10-06 :
// 17 items, tous résolus, sévérités outage et disruption, un même guid par composant touché)
const xaiComponents = [
  'Global (api.x.ai)', 'US (us.api.x.ai)', 'grok.com', 'Grok (iOS)', 'Grok (Android)',
  'Grok in X', 'Grok (Build)', 'Grok (Office/Workspace Plugins)', 'Voice',
];
const xaiProvider = {
  ...provider,
  id: 'xai',
  statusUrl: 'https://status.x.ai',
  source: { kind: 'xai', url: 'https://status.x.ai/feed.xml', components: xaiComponents },
};
const xaiFeed = fixtureText('xai-feed.xml');
const xaiItems = xai.parseXaiRss(xaiFeed);
assert.strictEqual(xaiItems.length, 17, 'tous les items sont lus, sans lastBuildDate ni sévérité « available »');
assert.ok(xaiItems.every((item) => !item.active), 'historique entièrement résolu');
const x1 = await read(xai, xaiProvider, okText(xaiFeed));
assert.strictEqual(x1.status, 'operationnel', 'des incidents résolus ne rendent jamais la source illisible');
assert.deepStrictEqual(names(x1.components), xaiComponents);
assert.deepStrictEqual(x1.incidents, []);
assert.strictEqual(x1.collect.methodLabel, 'flux RSS officiel xAI');

// Incident en cours sur deux composants (même guid), dont un composant non déclaré
const firstItem = xaiFeed.match(/<item>[\s\S]*?<\/item>/)[0];
const activeItem = (component, guid, status, severity) => firstItem
  .replace(/\[[^\]]+\]/, `[${component}]`)
  .replaceAll('INC578e0bc8', guid)
  .replace('<h3>Status: RESOLVED</h3>', `<h3>Status: ${status}</h3>`)
  .replace('<p>Severity: outage</p>', `<p>Severity: ${severity}</p>`);
const liveFeed = xaiFeed.replace('<item>', `${activeItem('Global (api.x.ai)', 'INCabc1', 'INVESTIGATING', 'outage')}${activeItem('Nouveau service', 'INCabc1', 'INVESTIGATING', 'outage')}${activeItem('grok.com', 'INCdef2', 'MONITORING', 'disruption')}<item>`);
const x2 = await read(xai, xaiProvider, okText(liveFeed));
assert.strictEqual(x2.status, 'incident_majeur', 'une panne en cours est remontée, plus jamais masquée en « non vérifié »');
assert.strictEqual(x2.collect.state, 'ok');
assert.deepStrictEqual(impacted(x2.components), ['Global (api.x.ai)', 'grok.com', 'Nouveau service']);
assert.strictEqual(x2.components.find((c) => c.name === 'grok.com').status, 'degradation');
assert.strictEqual(x2.incidents.length, 2, 'un incident par guid');
assert.deepStrictEqual(x2.incidents[0].components, ['Global (api.x.ai)', 'Nouveau service']);
assert.strictEqual(x2.incidents[0].status, 'investigating');
assert.strictEqual(x2.incidents[1].status, 'monitoring');
const x3 = await read(xai, xaiProvider, okText(xaiFeed.replace('<item>', `${activeItem('Voice', 'INCghi3', 'SOMETHING NEW', 'unknown-level')}<item>`)));
assert.strictEqual(x3.status, 'degradation', 'état ou sévérité inconnus d’un incident non résolu : dégradation, jamais vert');
assert.strictEqual(x3.incidents[0].status, 'en cours');

for (const invalidFeed of [
  xaiFeed.replace('https://status.x.ai/api-global/INC578e0bc8', 'https://evil.test/INC578e0bc8'),
  xaiFeed.replace('<link>https://status.x.ai</link>', '<link>https://evil.test</link>'),
  xaiFeed.replace(' version="2.0"', ' version="1.0"'),
  xaiFeed.replace('<h3>Status: RESOLVED</h3>', '<h3>Status: RESOLVED</h3><h3>Status: RESOLVED</h3>'),
  xaiFeed.replace('<item>', `${firstItem}<item>`),
  xaiFeed.replace('[Global (api.x.ai)] ', ''),
  `<!DOCTYPE x>${xaiFeed}`,
  xaiFeed.replace('</rss>', ''),
  xaiFeed.replace('<item>', '</item><item>'),
  xaiFeed.replace('</channel>', `${'<item>'.repeat(2_000)}</channel>`),
]) {
  const failed = await read(xai, xaiProvider, okText(invalidFeed));
  assert.strictEqual(failed.status, 'inconnu', 'structure RSS inconnue ou lien étranger → jamais vert');
  assert.strictEqual(failed.collect.state, 'error');
}

// 7b. Instatus (Perplexity) : fixture réelle, tout OPERATIONAL ; états dégradés ; réponses cassées.
const iProvider = { ...provider, statusUrl: 'https://status.perplexity.com', source: { kind: 'instatus', url: 'https://status.perplexity.com' } };
const i1 = await read(instatus, iProvider, byUrl({ 'summary.json': fixture('instatus-perplexity-summary.json'), 'components.json': fixture('instatus-perplexity-components.json') }));
assert.strictEqual(i1.status, 'operationnel');
assert.deepStrictEqual(names(i1.components), ['Website', 'API', 'Computer']);
assert.strictEqual(i1.collect.state, 'ok');
const i2 = await read(instatus, iProvider, byUrl({
  'summary.json': { page: { status: 'HASISSUES' }, activeIncidents: [{ name: 'API errors', status: 'INVESTIGATING', impact: 'PARTIALOUTAGE', started: '2026-09-04T10:00:00Z', url: 'https://status.perplexity.com/incident/x' }], activeMaintenances: [] },
  'components.json': { components: [{ name: 'API', status: 'PARTIALOUTAGE' }, { name: 'Website', status: 'OPERATIONAL' }] },
}));
assert.strictEqual(i2.status, 'degradation');
assert.deepStrictEqual(impacted(i2.components), ['API']);
assert.strictEqual(i2.incidents[0].status, 'investigating');
const i3 = await read(instatus, iProvider, byUrl({ 'summary.json': { page: { status: 'UP' }, activeIncidents: null, activeMaintenances: null }, 'components.json': { components: [{ name: 'API', status: 'WEIRD' }] } }));
assert.strictEqual(i3.status, 'inconnu', 'vocabulaire inconnu → jamais vert');
assert.strictEqual(instatusComponentStatus('MAJOROUTAGE'), 'incident_majeur');
assert.strictEqual(instatusComponentStatus('__proto__'), 'inconnu');
assert.strictEqual((await read(instatus, iProvider, byUrl({
  'summary.json': { page: { status: 'UP' }, activeIncidents: [{ name: 'X', status: 'INVENTED' }], activeMaintenances: [] },
  'components.json': { components: [{ name: 'API', status: 'OPERATIONAL' }] },
}))).status, 'inconnu', 'un état actif inconnu est rejeté');
for (const map of [{ 'summary.json': { page: { status: 'UP' } }, 'components.json': { components: [] } }, { 'summary.json': {}, 'components.json': { components: [{ name: 'API', status: 'OPERATIONAL' }] } }, { 'summary.json': { page: { status: 'UP' } } }]) {
  const i = await read(instatus, iProvider, byUrl(map));
  assert.strictEqual(i.status, 'inconnu', `payload ${JSON.stringify(map)}`);
  assert.strictEqual(i.collect.state, 'error');
}
assert.strictEqual((await read(instatus, iProvider, failing)).status, 'inconnu');

// 7c. Better Stack (Together AI) : fixture réelle ; rapport ouvert ; ressource non surveillée ; cassé.
const bProvider = { ...provider, statusUrl: 'https://status.together.ai', source: { kind: 'betterstack', url: 'https://status.together.ai' } };
const together = fixture('betterstack-together-index.json');
const b1 = await read(betterstack, bProvider, okJson(together));
assert.strictEqual(b1.status, 'operationnel');
assert.ok(b1.components.length >= 20 && b1.components.some((c) => c.name === 'Website'));
assert.deepStrictEqual(b1.incidents, [], 'les rapports terminés (ends_at non null) sont ignorés');
assert.deepStrictEqual(b1.maintenances, []);
const b2Body = {
  data: {
    attributes: { aggregate_state: 'degraded' },
    relationships: {
      resources: { data: [{ id: '1', type: 'status_page_resource' }, { id: '2', type: 'status_page_resource' }] },
      status_reports: { data: [{ id: '9', type: 'status_report' }, { id: '10', type: 'status_report' }] },
    },
  },
  included: [
    { id: '1', type: 'status_page_resource', attributes: { public_name: 'API', status: 'degraded' } },
    { id: '2', type: 'status_page_resource', attributes: { public_name: 'Site', status: 'operational' } },
    { id: '9', type: 'status_report', attributes: { title: 'Slow API', report_type: 'manual', aggregate_state: 'degraded', starts_at: '2026-09-04T10:00:00Z', ends_at: null, affected_resources: [{ status_page_resource_id: '1', status: 'degraded' }] } },
    { id: '10', type: 'status_report', attributes: { title: 'Upgrade', report_type: 'maintenance', starts_at: '2026-09-04T09:00:00Z', ends_at: null, affected_resources: [] } },
  ],
};
const b2 = await read(betterstack, bProvider, okJson(b2Body));
assert.strictEqual(b2.status, 'degradation');
assert.deepStrictEqual(impacted(b2.components), ['API']);
assert.deepStrictEqual(b2.incidents[0].components, ['API']);
assert.strictEqual(b2.maintenances[0].state, 'in_progress');
const b3 = await read(betterstack, bProvider, okJson({
  data: { attributes: { aggregate_state: 'operational' }, relationships: { resources: { data: [{ id: '1', type: 'status_page_resource' }] }, status_reports: { data: [] } } },
  included: [{ id: '1', type: 'status_page_resource', attributes: { public_name: 'API', status: 'not_monitored' } }],
}));
assert.strictEqual(b3.status, 'inconnu', 'ressource non surveillée → jamais vert');
for (const body of [{}, { data: {} }, { data: { attributes: { aggregate_state: 'operational' } }, included: [] }]) {
  assert.strictEqual((await read(betterstack, bProvider, okJson(body))).status, 'inconnu', `payload ${JSON.stringify(body)}`);
}
assert.strictEqual((await read(betterstack, bProvider, httpFail(503))).status, 'inconnu');
const badReportEnd = structuredClone(b2Body);
badReportEnd.included.find((item) => item.id === '9').attributes.ends_at = 'jamais';
assert.strictEqual((await read(betterstack, bProvider, okJson(badReportEnd))).status, 'inconnu', 'une fin de rapport invalide est rejetée avant filtrage');
assert.strictEqual((await read(betterstack, bProvider, okJson({
  data: { attributes: { aggregate_state: 'operational' }, relationships: { resources: { data: [{ id: 'absent', type: 'status_page_resource' }] }, status_reports: { data: [] } } },
  included: [],
}))).status, 'inconnu', 'une relation sans objet inclus est incomplète');

// 7d. Checkly (Mistral) : fixture réelle sans incident ; incident ouvert ciblé ; incident sans services ; cassé.
const cProvider = { ...provider, statusUrl: 'https://status.mistral.ai', source: { kind: 'checkly', url: 'https://status.mistral.ai', slug: 'mistral-ai' } };
const uptime = fixture('checkly-mistral-uptime.json');
const cMap = (incidents, windows = { upcoming: [], active: [], recentlyCompleted: [], past: [] }) => byUrl({ '/uptime': uptime, 'unresolved-incidents': { incidents }, 'maintenance-windows': windows });
const c1 = await read(checkly, cProvider, cMap([]));
assert.strictEqual(c1.status, 'operationnel');
assert.strictEqual(c1.components.length, 17);
assert.ok(names(c1.components).includes('Chat Completions API'));
const chatId = uptime.metadata[0].services[0].id;
const c2 = await read(checkly, cProvider, cMap([{ id: 'x', name: 'Completion API Degraded', severity: 'MEDIUM', lastUpdateStatus: 'INVESTIGATING', services: [{ id: chatId }], created_at: '2026-09-04T10:00:00Z' }]));
assert.strictEqual(c2.status, 'degradation');
assert.deepStrictEqual(impacted(c2.components), ['Chat Completions API']);
assert.deepStrictEqual(c2.incidents[0].components, ['Chat Completions API']);
assert.strictEqual(c2.incidents[0].status, 'investigating');
const c3 = await read(checkly, cProvider, cMap([{ id: 'y', name: 'Outage', severity: 'CRITICAL', lastUpdateStatus: 'IDENTIFIED' }]));
assert.strictEqual(c3.status, 'indisponible');
assert.ok(c3.components.every((c) => c.status === 'inconnu'), 'incident sans liste de services → services illisibles');
const c4 = await read(checkly, cProvider, cMap([{ id: 'z', name: 'Old', severity: 'MINOR', lastUpdateStatus: 'RESOLVED', services: [] }]));
assert.strictEqual(c4.status, 'operationnel', 'incident résolu ignoré');
const c5 = await read(checkly, cProvider, cMap([], { upcoming: [], active: [{ name: 'Upgrade', startsAt: '2026-09-04T09:00:00Z' }] }));
assert.strictEqual(c5.status, 'maintenance');
assert.strictEqual(c5.maintenances[0].state, 'in_progress');
assert.strictEqual((await read(checkly, cProvider, byUrl({ '/uptime': uptime, 'unresolved-incidents': { incidents: [] } }))).status, 'inconnu', 'un endpoint en échec → inconnu');
assert.strictEqual((await read(checkly, cProvider, byUrl({ '/uptime': { metadata: [] }, 'unresolved-incidents': { incidents: [] }, 'maintenance-windows': { active: [] } }))).status, 'inconnu');
assert.strictEqual((await read(checkly, cProvider, byUrl({ '/uptime': uptime, 'unresolved-incidents': {}, 'maintenance-windows': { active: [] } }))).status, 'inconnu');
assert.strictEqual((await read(checkly, cProvider, byUrl({ '/uptime': { metadata: [{ services: {} }] }, 'unresolved-incidents': { incidents: [] }, 'maintenance-windows': { active: [] } }))).status, 'inconnu', 'une collection de services imbriquée doit être un tableau');
const duplicateUptime = structuredClone(uptime);
duplicateUptime.metadata[0].services.push({ ...duplicateUptime.metadata[0].services[0] });
assert.strictEqual((await read(checkly, cProvider, byUrl({ '/uptime': duplicateUptime, 'unresolved-incidents': { incidents: [] }, 'maintenance-windows': { active: [] } }))).status, 'inconnu', 'un service dupliqué est ambigu');
assert.strictEqual((await read(checkly, cProvider, cMap([{ id: 'bad-ref', name: 'X', severity: 'MINOR', lastUpdateStatus: 'INVESTIGATING', services: [{ id: chatId, name: 'Documentation' }] }]))).status, 'inconnu', 'un id et un nom contradictoires sont rejetés');
assert.strictEqual((await read(checkly, cProvider, cMap([{ id: 'bad-state', name: 'X', severity: 'MINOR', lastUpdateStatus: 'INVENTED', services: [] }]))).status, 'inconnu');
assert.strictEqual((await read(checkly, cProvider, cMap([{ id: 'bad-severity', name: 'X', severity: '__proto__', lastUpdateStatus: 'INVESTIGATING', services: [{ id: chatId }] }]))).status, 'inconnu', 'une propriété héritée ne devient jamais opérationnelle');
assert.strictEqual((await read(checkly, cProvider, cMap(Array(STATUS_LIMITS.events + 1).fill({ lastUpdateStatus: 'RESOLVED' })))).status, 'inconnu', 'les incidents sont bornés avant rattachement');

// 7e. OnlineOrNot (OpenRouter) : décodage turbo-stream ; fixture HTML réelle ; composant dégradé ; page sans données.
assert.deepStrictEqual(decodeTurboStream([{ _1: 2, _3: 4 }, 'a', 5, 'b', [6, -5], ['D', 7], '2026-09-04T00:00:00Z']), { a: 5, b: ['2026-09-04T00:00:00Z', null] });
assert.throws(() => decodeTurboStream([{ _1: 2 }, '__proto__', 5]), (error) => error.code === 'schema', 'les clés de prototype sont refusées');
const oProvider = { ...provider, statusUrl: 'https://status.openrouter.ai', source: { kind: 'onlineornot', url: 'https://status.openrouter.ai' } };
const orHtml = fixtureText('onlineornot-openrouter.html');
const orDoc = parseOnlineornotHtml(orHtml);
assert.strictEqual(orDoc.loaderData.root.result.statusPage.name, 'OpenRouter');
const o1 = await read(onlineornot, oProvider, okText(orHtml));
assert.strictEqual(o1.status, 'operationnel');
assert.strictEqual(o1.components.length, 10);
assert.ok(names(o1.components).includes('Chat (/api/v1/chat/completions)'));
assert.deepStrictEqual(o1.incidents, [], 'incidents terminés (ended non null) ignorés');
// Encodeur turbo-stream minimal pour fabriquer les cas observés et les alias de graphe
const turbo = (root) => {
  const flat = [];
  const seen = new Map();
  const enc = (v) => {
    if (v && typeof v === 'object' && seen.has(v)) return seen.get(v);
    const i = flat.push(null) - 1;
    if (v && typeof v === 'object') seen.set(v, i);
    if (Array.isArray(v)) flat[i] = v.map(enc);
    else if (v && typeof v === 'object') flat[i] = Object.fromEntries(Object.entries(v).map(([k, x]) => [`_${enc(k)}`, enc(x)]));
    else flat[i] = v;
    return i;
  };
  enc(root);
  return `<html><body><script>window.__reactRouterContext.streamController.enqueue(${JSON.stringify(JSON.stringify(flat))});</script></body></html>`;
};
const onlineHtml = (components, incidents = {}, activeIncidents = []) => turbo({ loaderData: {
  root: { result: { components } },
  'routes/_index': { result: { incidents, activeIncidents } },
} });
const activeOnlineIncident = { id: 'abc', title: 'Chat down', impact: 'MAJOR_OUTAGE', started: '2026-09-04T10:00:00Z', ended: null, updates: [{ status: 'INVESTIGATING', createdAt: '2026-09-04T10:01:00Z' }] };
const degradedHtml = onlineHtml(
  [{ name: 'Chat (/api/v1/chat/completions)', status: 'MAJOR_OUTAGE' }, { name: 'Models', status: 'OPERATIONAL' }],
  { '2026-09-04T00:00:00.000Z': [activeOnlineIncident] },
  [activeOnlineIncident],
);
const o2 = await read(onlineornot, oProvider, okText(degradedHtml));
assert.strictEqual(o2.status, 'incident_majeur');
assert.deepStrictEqual(impacted(o2.components), ['Chat (/api/v1/chat/completions)']);
assert.strictEqual(o2.incidents.length, 1);
assert.strictEqual(o2.incidents[0].status, 'investigating');
assert.strictEqual(o2.incidents[0].url, 'https://status.openrouter.ai/incidents/abc');
const o3 = await read(onlineornot, oProvider, okText(orHtml.replace(/OPERATIONAL/g, 'WEIRD')));
assert.strictEqual(o3.status, 'inconnu', 'vocabulaire inconnu → jamais vert');
const o4 = await read(onlineornot, oProvider, okText('<html><body>Page not found</body></html>'));
assert.strictEqual(o4.status, 'inconnu');
assert.ok(/SSR/.test(o4.collect.error));
assert.strictEqual((await read(onlineornot, oProvider, httpFail(502))).status, 'inconnu');
const sharedIncidents = [{ id: 'alias', title: 'Alias', ended: null, updates: [] }];
const o5 = await read(onlineornot, oProvider, okText(onlineHtml(
  [{ name: 'Models', status: 'OPERATIONAL' }],
  { first: sharedIncidents, second: sharedIncidents },
)));
assert.strictEqual(o5.status, 'inconnu', 'un tableau d’incidents aliasé est rejeté avant expansion');
const sharedComponent = { name: 'x'.repeat(60_000), status: 'OPERATIONAL' };
const o6 = await read(onlineornot, oProvider, okText(onlineHtml([sharedComponent, sharedComponent])));
assert.strictEqual(o6.status, 'inconnu', 'des composants aliasés ne dépassent pas le budget fournisseur');
assert.match(o6.collect.error, /^schéma inattendu/);
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([{ name: 'Models', status: 'OPERATIONAL' }, { name: 'Models', status: 'OPERATIONAL' }])))).status, 'inconnu', 'deux composants de même identité sont rejetés');
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([null])))).status, 'inconnu', 'aucun composant mal formé n’est supprimé silencieusement');
assert.strictEqual((await read(onlineornot, oProvider, okText(turbo({ loaderData: { root: { result: { components: [{ name: 'Models', status: 'OPERATIONAL' }] } }, 'routes/_index': { result: {} } } })))).status, 'inconnu', 'le dataset incidents doit être explicitement présent');
assert.strictEqual((await read(onlineornot, oProvider, okText(turbo({ loaderData: { root: { result: { components: [{ name: 'Models', status: 'OPERATIONAL' }] } }, 'routes/_index': { result: { incidents: {} } } } })))).status, 'inconnu', 'le dataset activeIncidents doit être explicitement présent');
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([{ name: 'Models', status: 'OPERATIONAL' }], { today: [{ title: 'X', ended: 'jamais', updates: [] }] })))).status, 'inconnu', 'une fin invalide ne masque pas un incident');
const invalidActive = { ...activeOnlineIncident, id: 'bad-state', updates: [{ status: 'INVENTED' }] };
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([{ name: 'Models', status: 'OPERATIONAL' }], { today: [invalidActive] }, [invalidActive])))).status, 'inconnu', 'un état actif inconnu est rejeté');
const unknownImpact = { ...activeOnlineIncident, id: 'bad-impact', impact: 'INVENTED' };
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([{ name: 'Models', status: 'OPERATIONAL' }], { today: [unknownImpact] }, [unknownImpact])))).status, 'inconnu', 'un impact actif inconnu ne peut jamais rester vert');
const genericUpdate = { ...activeOnlineIncident, id: 'generic-update', impact: 'NO_IMPACT', updates: [{ status: 'UPDATE', createdAt: '2026-09-04T10:01:00Z' }] };
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([{ name: 'Models', status: 'OPERATIONAL' }], { today: [genericUpdate] }, [genericUpdate])))).status, 'degradation', 'une mise à jour active documentée ne peut pas rester verte');
const noImpactField = { ...activeOnlineIncident, id: 'no-impact-field' };
delete noImpactField.impact;
assert.strictEqual((await read(onlineornot, oProvider, okText(onlineHtml([{ name: 'Models', status: 'OPERATIONAL' }], { today: [noImpactField] }, [noImpactField])))).status, 'degradation', 'le SSR public sans impact conserve le plancher incident');

// 7f. AWS (Bedrock) : codes ; fixture réelle en UTF-16 (deux régions ME disrupted) ; tout calme ; cassé.
assert.strictEqual(awsCode('0'), 'operationnel');
assert.strictEqual(awsCode('1'), 'degradation');
assert.strictEqual(awsCode('3'), 'incident_majeur');
assert.strictEqual(awsCode('7'), 'inconnu');
const wProvider = { ...provider, statusUrl: 'https://health.aws.amazon.com/health/status', source: { kind: 'aws', url: 'https://health.aws.amazon.com/health/status', eventsUrl: 'https://health.aws.amazon.com/public/currentevents', servicesUrl: 'https://servicedata-eu-west-1-prod.s3.amazonaws.com/services.json', serviceName: 'Amazon Bedrock' } };
const awsEvents = fixture('aws-currentevents.json');
const awsServices = fixture('aws-services.json');
const w1 = await read(aws, wProvider, byUrlBytes({ currentevents: utf16(awsEvents), 'services.json': utf8bom(awsServices) }));
assert.strictEqual(w1.status, 'incident_majeur');
assert.deepStrictEqual(impacted(w1.components).sort(), ['Amazon Bedrock (Bahrain)', 'Amazon Bedrock (UAE)']);
assert.ok(w1.components.length > 20 && w1.components.every((c) => c.name.startsWith('Amazon Bedrock (')), 'une entrée par région Bedrock, jamais AgentCore');
assert.strictEqual(w1.incidents.length, 2, 'l’événement résolu (status 0, end_time) est ignoré');
assert.deepStrictEqual(w1.incidents[0].components, ['Amazon Bedrock (UAE)']);
const w2 = await read(aws, wProvider, byUrlBytes({ currentevents: utf16([]), 'services.json': utf8bom(awsServices) }));
assert.strictEqual(w2.status, 'operationnel');
assert.deepStrictEqual(impacted(w2.components), []);
const w3 = await read(aws, wProvider, byUrlBytes({ currentevents: utf16([{ status: '2', service: 'bedrock-us-east-1', summary: 'Latencies', date: '1788472198' }]), 'services.json': utf8bom(awsServices) }));
assert.strictEqual(w3.status, 'degradation');
assert.deepStrictEqual(impacted(w3.components), ['Amazon Bedrock (N. Virginia)']);
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([]) }))).status, 'inconnu');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16({}), 'services.json': utf8bom(awsServices) }))).status, 'inconnu');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([]), 'services.json': utf8bom([{ service: 'ec2-us-east-1', service_name: 'Amazon EC2' }]) }))).status, 'inconnu', 'aucun service du périmètre → inconnu');
const bedrockService = awsServices.find((service) => service.service_name === 'Amazon Bedrock');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([]), 'services.json': utf8bom([{ ...bedrockService, service: null }]) }))).status, 'inconnu', 'l’identité du catalogue est obligatoire');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([]), 'services.json': utf8bom([bedrockService, { ...bedrockService }]) }))).status, 'inconnu', 'un id de service dupliqué est rejeté');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([{ status: '2', service: bedrockService.service, end_time: 'jamais' }]), 'services.json': utf8bom(awsServices) }))).status, 'inconnu', 'une fin d’événement invalide ne le masque pas');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16(Array(STATUS_LIMITS.events + 1).fill({ status: '0', end_time: '1' })), 'services.json': utf8bom(awsServices) }))).status, 'inconnu', 'les événements sont bornés avant rattachement');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([{ status: '2', service: 'bedrock-new-region', service_name: 'Amazon Bedrock' }]), 'services.json': utf8bom(awsServices) }))).status, 'inconnu', 'un événement Bedrock sans région joignable ne peut pas être ignoré');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([{ status: '3', service: 'multipleservices-us-east-1', service_name: 'Multiple services', impacted_services: { 'ec2-us-east-1': { service_name: 'Amazon EC2', current: '3' } } }]), 'services.json': utf8bom(awsServices) }))).status, 'operationnel', 'un événement explicitement hors périmètre reste ignoré');
assert.strictEqual((await read(aws, wProvider, byUrlBytes({ currentevents: utf16([]), 'services.json': utf8bom([bedrockService, ...Array(10_000).fill({ service: 'ec2-us-east-1', service_name: 'Amazon EC2' })]) }))).status, 'inconnu', 'le catalogue source reste borné au-dessus du volume réel mesuré');

// 7g. Azure : fixture réelle expurgée (Good partout) ; Warning ; label inconnu ; service absent ; page vide.
const zProvider = { ...provider, statusUrl: 'https://azure.status.microsoft/en-us/status', source: { kind: 'azure', url: 'https://azure.status.microsoft/en-us/status', services: ['Azure OpenAI Service', 'Foundry Models', 'Azure AI Search'] } };
const azHtml = fixtureText('azure-status-rows.html');
assert.ok(parseAzureRows(azHtml).get('Azure OpenAI Service').length > 10, 'cellules agrégées sur toutes les zones');
const z1 = await read(azure, zProvider, okText(azHtml));
assert.strictEqual(z1.status, 'operationnel');
assert.deepStrictEqual(names(z1.components), ['Azure OpenAI Service', 'Foundry Models', 'Azure AI Search']);
const z2 = await read(azure, zProvider, okText(azHtml.replace('<td>Foundry Models</td><td class="status-cell"><span class="icon status-icon" data-label="Not available">', '<td>Foundry Models</td><td class="status-cell"><span class="icon status-icon" data-label="Warning">')));
assert.strictEqual(z2.status, 'degradation');
assert.deepStrictEqual(impacted(z2.components), ['Foundry Models']);
const z3 = await read(azure, zProvider, okText(azHtml.replace(/data-label="Good"/g, 'data-label="Weird"')));
assert.strictEqual(z3.status, 'inconnu', 'libellé inconnu → jamais vert');
const z4 = await read(azure, { ...zProvider, source: { ...zProvider.source, services: ['Azure OpenAI Service', 'Inexistant'] } }, okText(azHtml));
assert.strictEqual(z4.status, 'operationnel');
assert.ok(/Inexistant/.test(z4.collect.error), 'service absent signalé sans casser la collecte');
const z5 = await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td data-label="Not available"></td></tr>'));
assert.strictEqual(z5.status, 'inconnu', 'aucune cellule lisible → inconnu');
assert.strictEqual((await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td class="status-cell"><span class="status-icon" data-label="Good"></span></td><td class="status-cell"><span></span></td></tr>'))).status, 'inconnu', 'une cellule régionale illisible ne disparaît pas derrière une cellule saine');
assert.strictEqual((await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td class="status-cell"><span class="status-icon" data-label="junk data-label="Good" "></span></td></tr>'))).status, 'inconnu', 'une valeur malformée ne peut pas révéler un faux label interne');
assert.strictEqual((await read(azure, zProvider, okText("<tr><td>Azure OpenAI Service</td><td class='status-cell'><span class='status-icon' DATA-LABEL = 'Warning'></span></td></tr>"))).status, 'degradation', 'nom d’attribut HTML insensible à la casse et guillemets simples');
assert.strictEqual((await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td class="status-cell"><span class="status-icon" data-data-label="Warning"></span></td></tr>'))).status, 'inconnu', 'un attribut préfixé ne vaut pas data-label');
assert.strictEqual((await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td class="status-cell"><!-- <span class="status-icon" data-label="Warning"></span> --><span class="status-icon" data-label="Good"></span></td></tr>'))).status, 'operationnel', 'un faux attribut en commentaire est ignoré');
assert.strictEqual((await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td class="status-cell"><span class="status-icon" data-label="Good" data-label="Warning"></span></td></tr>'))).status, 'inconnu', 'un attribut exact dupliqué est ambigu');
assert.strictEqual((await read(azure, zProvider, okText('<tr><td>Azure OpenAI Service</td><td class="status-cell"><em data-label="Warning"></em><span data-label="Good"></span></td></tr>'))).status, 'inconnu', 'un marqueur non qualifié ne peut pas rendre le service vert');
assert.strictEqual((await read(azure, zProvider, okText('<tr>'.repeat(10_000)))).status, 'inconnu', 'lignes incomplètes : rejet borné');
assert.strictEqual((await read(azure, zProvider, okText('<html></html>'))).status, 'inconnu');
assert.strictEqual((await read(azure, zProvider, httpFail(500))).status, 'inconnu');

// 7h. Tencent (Hunyuan) : fixture réelle ; ABNORMAL ; région vide ; cassé.
const tProvider = { ...provider, statusUrl: 'https://status.cloud.tencent.com', source: { kind: 'tencent', url: 'https://status.cloud.tencent.com', regionId: 'non-regional', productIds: ['hunyuan', 'aiart'] } };
const t1 = await read(tencent, tProvider, okJson(fixture('tencent-nonregional.json')));
assert.strictEqual(t1.status, 'operationnel');
assert.deepStrictEqual(names(t1.components).sort(), ['腾讯混元大模型', '腾讯混元生图']);
const t2 = await read(tencent, tProvider, okJson({ Response: { Data: { CategoryList: [{ ProductList: [
  { ProductId: 'hunyuan', ProductName: '腾讯混元大模型', CurrentStatus: 'ABNORMAL', ProductEventTitle: 'API 异常', Rss: 'https://status.cloud.tencent.com/rss/zh/non-regional/hunyuan' },
  { ProductId: 'aiart', ProductName: '腾讯混元生图', CurrentStatus: 'NORMAL' },
] }] } } }));
assert.strictEqual(t2.status, 'degradation');
assert.strictEqual(t2.incidents[0].title, 'API 异常');
assert.strictEqual((await read(tencent, tProvider, okJson({ Response: { Data: { CategoryList: [{ ProductList: [{ ProductId: 'hunyuan', CurrentStatus: 'BIZARRE' }, { ProductId: 'aiart', CurrentStatus: 'NORMAL' }] }] } } }))).status, 'inconnu');
assert.strictEqual((await read(tencent, tProvider, okJson({ Response: { Data: { CategoryList: [{ ProductList: [{ ProductId: 'hunyuan', CurrentStatus: 'NORMAL' }] }] } } }))).status, 'inconnu', 'produit attendu absent → inconnu');
assert.strictEqual((await read(tencent, tProvider, okJson({ Response: { Data: { CategoryList: [{ ProductList: [{ ProductId: 'hunyuan', CurrentStatus: 'NORMAL' }, { ProductId: 'hunyuan', CurrentStatus: 'NORMAL' }] }] } } }))).status, 'inconnu', 'un doublon ne masque pas un produit absent');
assert.strictEqual((await read(tencent, tProvider, okJson({ Response: { Data: { Summary: {}, CategoryList: [] } } }))).status, 'inconnu', 'région inconnue = liste vide → inconnu');
assert.strictEqual((await read(tencent, tProvider, okJson({}))).status, 'inconnu');

// 7i. Volcengine (Ark) : flux réels (Pékin : événements résolus ; Shanghai : vide) ; événement en cours ; région bidon.
const vProvider = { ...provider, statusUrl: 'https://status.volcengine.com', source: { kind: 'volcengine', url: 'https://status.volcengine.com', product: 'ModelArk', productLabel: '火山方舟', regions: ['cn-beijing', 'cn-shanghai'] } };
const rssBeijing = fixtureText('volcengine-modelark-cn-beijing.rss');
assert.strictEqual(parseVolcengineRss(rssBeijing).region, '华北2（北京）');
assert.strictEqual(parseVolcengineRss(rssBeijing).items.length, 2);
assert.strictEqual(parseVolcengineRss(rssBeijing, 'cn-beijing').region, '华北2（北京）');
assert.throws(() => parseVolcengineRss(rssBeijing.replace('version="2.0"', 'data-version="2.0"')), (error) => error.code === 'schema');
assert.throws(() => parseVolcengineRss(rssBeijing.replace('version="2.0"', 'version="2.0" version="1.0"')), (error) => error.code === 'schema');
assert.throws(() => parseVolcengineRss(rssBeijing.replace('version="2.0"', 'version="junk version="2.0" "')), (error) => error.code === 'schema');
const rssShanghai = fixtureText('volcengine-modelark-cn-shanghai.rss');
assert.strictEqual(parseVolcengineRss(rssShanghai.replaceAll('华东2（上海）', '华南1（广州）'), 'cn-guangzhou').region, '华南1（广州）');
assert.strictEqual(parseVolcengineRss(rssShanghai.replaceAll('华东2（上海）', '亚太东南（柔佛）'), 'ap-southeast-1').region, '亚太东南（柔佛）');
const v1 = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing, 'cn-shanghai': rssShanghai }));
assert.strictEqual(v1.status, 'operationnel', 'événements marqués 已恢复 → résolus');
assert.deepStrictEqual(names(v1.components), ['火山方舟 (华北2（北京）)', '火山方舟 (华东2（上海）)']);
assert.deepStrictEqual(v1.incidents, []);
const v2 = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing.replace('方舟大模型服务平台异常(已恢复)', '方舟大模型服务平台异常'), 'cn-shanghai': rssShanghai }));
assert.strictEqual(v2.status, 'degradation');
assert.deepStrictEqual(impacted(v2.components), ['火山方舟 (华北2（北京）)']);
assert.strictEqual(v2.incidents.length, 1);
const vSuffix = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing.replace('方舟大模型服务平台异常(已恢复)', '方舟大模型服务平台异常(已恢复) 后续'), 'cn-shanghai': rssShanghai }));
assert.strictEqual(vSuffix.status, 'degradation', '已恢复 doit être le suffixe terminal du titre');
assert.strictEqual((await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing.replace('方舟大模型服务平台异常(已恢复)', '方舟大模型服务平台异常（已恢复）'), 'cn-shanghai': rssShanghai }))).status, 'operationnel', 'suffixe 已恢复 en parenthèses pleine chasse : résolu');
const v3 = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing, 'cn-shanghai': '<rss version="2.0"><channel><title>火山引擎火山方舟大模型服务平台()服务状态</title></channel></rss>' }));
assert.strictEqual(v3.status, 'inconnu', 'région sans nom (inexistante) → composant illisible, jamais vert');
const vCross = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssShanghai, 'cn-shanghai': rssShanghai }));
assert.strictEqual(vCross.status, 'inconnu', 'un flux d’une autre région ne prouve jamais Pékin opérationnel');
const vFragment = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing, 'cn-shanghai': '<channel><title>火山引擎火山方舟大模型服务平台(华东2（上海）)服务状态</title></channel>' }));
assert.strictEqual(vFragment.status, 'inconnu', 'un fragment sans enveloppe RSS ne prouve jamais une région opérationnelle');
const vUnclosed = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing, 'cn-shanghai': rssShanghai.replace('</channel>', `${'<item>'.repeat(2_000)}</channel>`) }));
assert.strictEqual(vUnclosed.status, 'inconnu', 'items incomplets : rejet borné');
const vForeign = await read(volcengine, vProvider, byUrlText({ 'cn-beijing': rssBeijing, 'cn-shanghai': rssShanghai.replace('</channel>', '<foreign></channel>') }));
assert.strictEqual(vForeign.status, 'inconnu', 'une balise étrangère incomplète invalide le XML');
const v4 = await read(volcengine, vProvider, httpFail(500));
assert.strictEqual(v4.status, 'inconnu');
assert.match(v4.collect.error, /^réponse HTTP : 500/, 'toutes les régions en HTTP : classification conservée');
const v5 = await read(volcengine, vProvider, okText('GetRSS failed'));
assert.match(v5.collect.error, /^schéma inattendu/);
assert.strictEqual(v5.status, 'inconnu');

// 8. Assemblage v2 : collectAll isole les échecs, buildOutput produit le contrat.
const decl = [
  { id: 'a', name: 'A', group: 'us', statusUrl: 'https://a', scope: 'API A', source: { kind: 'sp' }, modelPattern: '^m-' },
  // b : adaptateur inconnu ; c : sans motif ; d : source injoignable
  { id: 'b', name: 'B', statusUrl: 'https://b', source: { kind: 'boom' } },
  { id: 'c', name: 'C', statusUrl: 'https://c', source: { kind: 'sp' } },
  { id: 'd', name: 'D', statusUrl: 'https://d', source: { kind: 'unavailable', note: 'injoignable' } },
];
const adapters = {
  sp: { METHOD: { fr: 'API SP', en: 'SP API' }, collect: async (p) => p.id === 'a'
    ? { indicator: 'incident_majeur', rawStatus: 'Major outage', components: [{ name: 'm-1', status: 'incident_majeur' }, { name: 'API', status: 'operationnel' }], incidents: [{ title: 'Down', state: 'investigating', createdAt: '2026-09-03T10:00:00Z' }] }
    : { indicator: 'operationnel', components: [{ name: 'API', status: 'operationnel' }], maintenances: [{ title: 'M', state: 'scheduled' }] } },
  unavailable,
};
const settled = await collectAll(decl, adapters, okJson({}));
assert.strictEqual(settled[1].status, 'rejected', 'adaptateur inconnu : rejet isolé, pas de plantage');
const out = buildOutput(decl, settled, '2026-09-03T12:00:00Z', adapters);
assert.strictEqual(out.schemaVersion, 2);
assert.deepStrictEqual(out.labels, STATUS_LABELS);
assert.strictEqual(out.summary.worst, 'incident_majeur');
assert.deepStrictEqual(out.summary.counts, { operationnel: 1, maintenance: 0, degradation: 0, incident_majeur: 1, indisponible: 0, inconnu: 2 });
assert.strictEqual(out.summary.activeIncidents, 1, 'seul l’incident actif est publié');
assert.strictEqual(out.summary.activeMaintenances, 0, 'maintenance planifiée non comptée comme active');
const [pa, pb, , pd] = out.providers;
assert.strictEqual(pa.group, 'us');
assert.strictEqual(pb.group, null, 'groupe absent transmis tel quel, jamais inventé');
assert.strictEqual(pa.components[0].kind, 'model');
assert.strictEqual(pa.components[1].kind, 'service');
assert.strictEqual(pa.reason, '1 composant en incident majeur');
assert.strictEqual(pa.reasonEn, '1 component major incident');
assert.deepStrictEqual(out.labelsEn, STATUS_LABELS_EN);
assert.strictEqual(pa.incidents.length, 1);
assert.strictEqual(pa.incidents[0].status, 'investigating');
assert.strictEqual(pb.status, 'inconnu');
assert.strictEqual(pb.name, 'B', 'identité conservée en échec');
assert.strictEqual(pb.collect.error, 'adaptateur inconnu : boom');
assert.strictEqual(pb.collect.errorEn, 'unknown adapter: boom');
assert.strictEqual(pd.collect.method, 'unavailable');
assert.strictEqual(pa.collect.methodLabel, 'API SP');
assert.strictEqual(pa.collect.methodLabelEn, 'SP API');
assert.strictEqual(pb.collect.methodLabel, null, 'famille inconnue : pas de libellé');
assert.strictEqual(pd.collect.methodLabel, 'aucune requête');
assert.strictEqual(pd.collect.methodLabelEn, 'no request');
assert.strictEqual(pd.collect.error, 'injoignable', 'source injoignable : la note seule, sans préfixe');
assert.strictEqual(pd.collect.errorEn, 'injoignable', 'sans noteEn, la note FR sert en anglais');
assert.strictEqual(pd.reason, 'source non lue');
assert.strictEqual(pd.reasonEn, 'source not read');
// 8b. Dérivation du statut par le contrat : indicateur, composants, maintenance en cours
const derive = (value) => buildProvider(decl[2], { status: 'fulfilled', value: { collectedAt: 'now', ...value } }).status;
assert.strictEqual(derive({ indicator: 'operationnel', components: [{ name: 'X', status: 'bizarre' }] }), 'inconnu', 'composant au vocabulaire inconnu : jamais vert');
assert.strictEqual(derive({ indicator: null, components: [] }), 'operationnel', 'sans indicateur ni composant : aucun incident déclaré');
assert.strictEqual(derive({ indicator: null, components: [{ name: 'A', status: 'degradation' }, { name: 'B', status: 'inconnu' }] }), 'degradation', 'un état réel l’emporte sur inconnu');
assert.strictEqual(derive({ indicator: 'degradation', components: [{ name: 'A', status: 'operationnel' }] }), 'degradation', 'indicateur de page seul');
assert.strictEqual(derive({ indicator: 'operationnel', components: [{ name: 'A', status: 'incident_majeur' }] }), 'incident_majeur', 'composant pire que l’indicateur');
assert.strictEqual(derive({ indicator: 'operationnel', components: [], maintenances: [{ title: 'M', state: 'in_progress' }] }), 'maintenance', 'maintenance en cours');
assert.strictEqual(derive({ indicator: 'operationnel', components: [], maintenances: [{ title: 'M', state: 'scheduled' }] }), 'operationnel', 'maintenance planifiée : sans effet');
assert.strictEqual(derive({ indicator: 'operationnel', components: [], incidents: [{ title: 'X', state: 'investigating' }] }), 'degradation', 'un incident actif ne peut jamais coexister avec un état vert');
assert.strictEqual(derive({ indicator: 'bizarre', components: [] }), 'inconnu', 'indicateur hors enum : inconnu');
// 8c. Un adaptateur rejeté est forcé à inconnu, quoi qu'il ait pu promettre
const py = buildProvider(decl[2], { status: 'rejected', reason: new Error('x') });
assert.strictEqual(py.status, 'inconnu');
assert.strictEqual(py.collect.state, 'error');
// 8d. Sans « inconnu », worst reste calculé sur les états réels ; tout inconnu → operationnel avec compteur.
const out2 = buildOutput([decl[3]], [settled[3]], '2026-09-03T12:00:00Z');
assert.strictEqual(out2.summary.worst, 'operationnel');
assert.strictEqual(out2.summary.counts.inconnu, 1);

// 9. Frontière de confiance : un résultat mal formé est rejeté avant allSettled,
// sans contaminer le fournisseur valide ni le contrat final.
const strictProviders = [
  { ...provider, id: 'good', name: 'Good', source: { kind: 'strict', url: 'https://ex.com' } },
  { ...provider, id: 'bad', name: 'Bad', source: { kind: 'strict', url: 'https://ex.com' } },
];
const goodResult = { indicator: 'operationnel', components: [{ name: 'API', status: 'operationnel' }] };
const malformed = [
  { indicator: 'operationnel', components: 'oops' },
  { indicator: 'operationnel', components: [{ name: null, status: 'operationnel' }] },
  { indicator: 'operationnel', components: [], incidents: [{ title: 7, state: 'en cours' }] },
  { indicator: 'operationnel', components: [], incidents: [{ title: 'X', state: 'resolved' }] },
  { indicator: 'operationnel', components: [], incidents: [{ title: 'X', state: 'en cours', createdAt: 'jamais' }] },
  { indicator: null, components: [] },
  { indicator: 'operationnel', components: Array(STATUS_LIMITS.components + 1).fill({ name: 'API', status: 'operationnel' }) },
  { indicator: 'operationnel', components: [{ name: 'x'.repeat(60_000), status: 'operationnel' }, { name: 'x'.repeat(60_000), status: 'operationnel' }] },
];
for (const badResult of malformed) {
  const strict = { collect: async (p) => p.id === 'good' ? goodResult : badResult };
  const results = await collectAll(strictProviders, { strict }, okJson({}));
  assert.strictEqual(results[0].status, 'fulfilled');
  assert.strictEqual(results[1].status, 'rejected');
  const isolated = buildOutput(strictProviders, results, '2026-09-03T12:00:00Z', { strict });
  assert.strictEqual(isolated.providers[0].status, 'operationnel');
  assert.strictEqual(isolated.providers[1].status, 'inconnu');
  assert.strictEqual(isolated.providers[1].collect.state, 'error');
  assert.strictEqual(validateStatusDocument(isolated, strictProviders), true);
}

// Les URL facultatives hostiles disparaissent ; même origine et shortlinks Statuspage restent.
const links = await collectAll([provider], { statuspage: { collect: async () => ({
  indicator: 'operationnel',
  components: [],
  incidents: [
    { title: 'Safe', state: 'investigating', url: 'https://stspg.io/ok' },
    { title: 'Hostile', state: 'monitoring', url: 'javascript:alert(1)' },
  ],
}) } }, okJson({}));
const linked = buildProvider(provider, links[0]);
assert.deepStrictEqual(linked.incidents.map((incident) => incident.url), ['https://stspg.io/ok', null]);
assert.strictEqual(safeExternalUrl('https://ex.com/detail', provider.statusUrl, 'statuspage'), 'https://ex.com/detail');
assert.strictEqual(safeExternalUrl('https://stspg.io/x', provider.statusUrl, 'statuspage'), 'https://stspg.io/x');
for (const url of ['http://ex.com/x', 'https://evil.test/x', 'https://user@ex.com/x', 'javascript:alert(1)', 'data:text/plain,x']) {
  assert.strictEqual(safeExternalUrl(url, provider.statusUrl, 'statuspage'), null, url);
}

// Le seam HTTP commun garde son délai jusqu'au dernier octet, borne le corps et
// refuse toute destination non prévue avant le second fetch
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      const timer = setTimeout(() => {
        controller.enqueue(new TextEncoder().encode('trop tard'));
        controller.close();
      }, 100);
      signal.addEventListener('abort', () => {
        clearTimeout(timer);
        controller.error(signal.reason);
      }, { once: true });
    },
  }));
  await assert.rejects(
    httpGet('https://source.test/data', { as: 'text', timeoutMs: 10 }),
    (error) => error.name === 'AbortError',
    'le délai couvre le corps',
  );

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(6));
      controller.enqueue(new Uint8Array(6));
      controller.close();
    },
  }), { headers: { 'Content-Length': '1' } });
  await assert.rejects(
    httpGet('https://source.test/data', { as: 'bytes', maxBytes: 10 }),
    (error) => error.code === 'limit',
    'les octets réellement décodés font foi',
  );

  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, redirect: options.redirect });
    if (url.startsWith('https://replicatestatus.com/')) {
      return new Response(null, { status: 301, headers: { Location: 'https://www.replicatestatus.com/api/v2/summary.json' } });
    }
    return new Response('{"ok":true}');
  };
  assert.deepStrictEqual(
    await httpGet('https://replicatestatus.com/api/v2/summary.json', { redirectOrigins: ['https://www.replicatestatus.com'] }),
    { ok: true },
  );
  assert.deepStrictEqual(requests.map((request) => request.redirect), ['manual', 'manual']);

  // Une seule nouvelle tentative, sur 429/5xx/réseau uniquement, dans le délai total
  let calls = 0;
  globalThis.fetch = async () => (++calls === 1 ? new Response('x', { status: 503, headers: { 'Retry-After': '0' } }) : new Response('{"ok":true}'));
  assert.deepStrictEqual(await httpGet('https://source.test/data'), { ok: true }, '503 isolé : relu une fois');
  assert.strictEqual(calls, 2);
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('x', { status: 503, headers: { 'Retry-After': '0' } }); };
  await assert.rejects(httpGet('https://source.test/data'), (error) => error.code === 'http' && error.status === 503);
  assert.strictEqual(calls, 2, 'jamais plus de deux essais');
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('x', { status: 404 }); };
  await assert.rejects(httpGet('https://source.test/data'), (error) => error.status === 404);
  assert.strictEqual(calls, 1, 'pas de nouvelle tentative hors 429/5xx');
  calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('x', { status: 503 }); };
  await assert.rejects(httpGet('https://source.test/data', { timeoutMs: 1500 }), (error) => error.status === 503);
  assert.strictEqual(calls, 1, 'pas de nouvelle tentative qui dépasserait le délai total');
  globalThis.fetch = async () => new Response('<!DOCTYPE html><title>Just a moment</title>', { headers: { 'Content-Type': 'text/html' } });
  await assert.rejects(httpGet('https://source.test/data'), (error) => error.code === 'schema' && /non JSON \(text\/html/.test(error.detail), 'page HTML : schéma, pas réseau');

  const expectedBytes = new Uint8Array([0xff, 0xfe, 0x7b, 0x00]);
  globalThis.fetch = async () => new Response(expectedBytes);
  assert.deepStrictEqual(await httpGet('https://source.test/data', { as: 'bytes' }), expectedBytes);

  requests.length = 0;
  globalThis.fetch = async (url, options) => {
    requests.push({ url, redirect: options.redirect });
    return new Response(null, { status: 302, headers: { Location: 'https://127.0.0.1/metadata' } });
  };
  await assert.rejects(
    httpGet('https://source.test/data'),
    (error) => error.code === 'policy',
    'une redirection hors origine est refusée',
  );
  assert.strictEqual(requests.length, 1, 'la cible refusée ne reçoit aucune requête');

  const policyProvider = {
    ...provider,
    source: {
      kind: 'policy-test',
      url: 'https://source.test',
      maxResponseBytes: 64,
      redirectOrigins: ['https://redirect.test'],
    },
  };
  let receivedOptions;
  const policyResult = await collectAll([policyProvider], { 'policy-test': {
    collect: async (_p, get) => {
      await get('https://source.test/data', { maxBytes: 1, redirectOrigins: ['https://evil.test'] });
      return { indicator: 'operationnel', components: [] };
    },
  } }, async (_url, options) => {
    receivedOptions = options;
    return {};
  });
  assert.strictEqual(policyResult[0].status, 'fulfilled');
  assert.strictEqual(receivedOptions.maxBytes, 64);
  assert.deepStrictEqual(receivedOptions.redirectOrigins, ['https://redirect.test']);
} finally {
  globalThis.fetch = originalFetch;
}

// Le même validateur couvre producteur, CI et navigateur, sans garde toujours vraie.
assert.strictEqual(validateStatusDocument(out, decl), true);
assert.strictEqual(validateStatusDocument(out2, [decl[3]]), true);
assert.ok(Buffer.byteLength(JSON.stringify(out) + '\n') < MAX_STATUS_BYTES);
const boundedFailure = buildOutput(
  [provider],
  [{ status: 'rejected', reason: new Error('界'.repeat(STATUS_LIMITS.string + 100)) }],
  '2026-09-03T12:00:00Z',
);
assert.ok(Buffer.byteLength(boundedFailure.providers[0].collect.error) <= STATUS_LIMITS.providerBytes / 4);
assert.strictEqual(validateStatusDocument(boundedFailure, [provider]), true, 'une erreur énorme reste isolée et bornée');
const oversizedProvider = buildProvider(provider, { status: 'fulfilled', value: {
  collectedAt: '2026-09-03T12:00:00Z', indicator: 'operationnel', rawStatus: 'x'.repeat(STATUS_LIMITS.string),
  note: 'x'.repeat(STATUS_LIMITS.string), components: [], incidents: [], maintenances: [],
} });
assert.strictEqual(oversizedProvider.collect.state, 'error', 'un fournisseur public hors budget est isolé avant assemblage');
const oversizedDocument = structuredClone(out);
oversizedDocument.providers[0].name = 'x'.repeat(60_000);
oversizedDocument.providers[0].reason = 'x'.repeat(60_000);
assert.strictEqual(validateStatusDocument(oversizedDocument), false, 'le contrat public applique le même budget fournisseur');
for (const mutate of [
  (doc) => { doc.providers[0].components[0].name = null; },
  (doc) => { doc.providers[1].id = doc.providers[0].id; },
  (doc) => { doc.summary.counts.inconnu += 1; },
  (doc) => { doc.summary.worst = 'degradation'; },
  (doc) => { doc.summary.activeIncidents += 1; },
  (doc) => { doc.summary.activeMaintenances += 1; },
  (doc) => { doc.providers[0].collectedAt = 'jamais'; },
  (doc) => { doc.providers[0].incidents[0].url = 'javascript:alert(1)'; },
]) {
  const invalid = structuredClone(out);
  mutate(invalid);
  assert.strictEqual(validateStatusDocument(invalid, decl), false);
}

// 9b. Contrat partagé : résumé produit et vérifié par la même fonction ; ordre d'affichage dérivé de la gravité.
assert.deepStrictEqual(summarize(out.providers), out.summary, 'buildOutput et la validation partagent summarize');
assert.deepStrictEqual(summarize([]), { worst: 'operationnel', counts: { operationnel: 0, maintenance: 0, degradation: 0, incident_majeur: 0, indisponible: 0, inconnu: 0 }, activeIncidents: 0, activeMaintenances: 0 });
assert.deepStrictEqual(DISPLAY_ORDER, ['indisponible', 'incident_majeur', 'degradation', 'maintenance', 'inconnu', 'operationnel'], 'pire d’abord, inconnu juste avant le vert');

// Statuspage filtré : état, événements et document final restent limités à Replicate
const scopedProvider = { ...provider, statusUrl: 'https://www.cloudflarestatus.com', source: { kind: 'statuspage', url: 'https://www.cloudflarestatus.com', componentIds: { fvgfcmy66tdr: 'Replicate' } } };
const scopedDoc = fixture('statuspage-cloudflare-replicate.json');
const scopedHealthy = { ...scopedDoc, status: { indicator: 'major', description: 'Global outage' }, incidents: [], scheduled_maintenances: [] };
assert.strictEqual((await read(statuspage, scopedProvider, okJson(scopedHealthy))).status, 'operationnel');
const scopedEvent = { id: 'event', name: 'Shared incident', status: 'investigating', impact: 'major', components: [{ id: 'fvgfcmy66tdr', name: 'Replicate' }, { id: 'other', name: 'Other' }], shortlink: 'https://www.cloudflarestatus.com/incidents/event' };
const sharedResult = await read(statuspage, scopedProvider, okJson({ ...scopedHealthy, incidents: [scopedEvent] }));
assert.strictEqual(sharedResult.status, 'incident_majeur');
assert.deepStrictEqual(sharedResult.incidents[0].components, ['Replicate']);
assert.ok(sharedResult.incidents[0].url);
assert.strictEqual((await read(statuspage, scopedProvider, okJson({ ...scopedHealthy, incidents: [{ ...scopedEvent, components: [{ id: 'other', name: 'Other' }] }] }))).status, 'operationnel');
assert.strictEqual((await read(statuspage, scopedProvider, okJson({ ...scopedHealthy, incidents: [{ ...scopedEvent, status: 'resolved' }] }))).status, 'operationnel');
for (const state of ['scheduled', 'in_progress', 'verifying', 'completed']) {
  const r = await read(statuspage, scopedProvider, okJson({ ...scopedHealthy, scheduled_maintenances: [{ ...scopedEvent, status: state }] }));
  assert.strictEqual(r.status, ['in_progress', 'verifying'].includes(state) ? 'maintenance' : 'operationnel');
  assert.strictEqual(r.maintenances.length, state === 'completed' ? 0 : 1);
}
assert.strictEqual((await read(statuspage, scopedProvider, okJson({ ...scopedHealthy, scheduled_maintenances: [{ ...scopedEvent, status: 'in_progress', components: [{ id: 'other', name: 'Other' }] }] }))).status, 'operationnel');
for (const doc of [
  { ...scopedHealthy, components: [] },
  { ...scopedHealthy, components: [{ ...scopedHealthy.components[0], name: 'Different' }] },
  { ...scopedHealthy, components: [...scopedHealthy.components, ...scopedHealthy.components] },
  { ...scopedHealthy, incidents: undefined },
  { ...scopedHealthy, scheduled_maintenances: undefined },
  { ...scopedHealthy, incidents: [{ ...scopedEvent, components: [{ name: 'Replicate' }] }] },
  { ...scopedHealthy, scheduled_maintenances: [{ ...scopedEvent, status: 'in_progress', components: null }] },
  { ...scopedHealthy, components: [{ ...scopedHealthy.components[0], status: 'NEW' }] },
]) assert.strictEqual((await read(statuspage, scopedProvider, okJson(doc))).status, 'inconnu');
assert.strictEqual((await read(statuspage, scopedProvider, okJson({ ...scopedHealthy, incidents: [{ ...scopedEvent, components: [] }] }))).status, 'operationnel', 'incident Cloudflare sans composant : hors périmètre Replicate, plus « non vérifié »');
assert.strictEqual((await read(statuspage, scopedProvider, httpFail(403))).status, 'inconnu');
const scopedSettled = await collectAll([scopedProvider], { statuspage }, okJson(scopedHealthy));
assert.ok(validateStatusDocument(buildOutput([scopedProvider], scopedSettled, new Date().toISOString(), { statuspage }), [scopedProvider]));

// 10. providers.json : cohérence des déclarations.
const providers = JSON.parse(readFileSync(new URL('../providers.json', import.meta.url), 'utf8'));
const kinds = new Set(['mistral_probe', 'incidentio', 'datadog', 'statuspage', 'alibaba', 'google', 'flashcat', 'xai', 'unavailable', 'instatus', 'betterstack', 'checkly', 'onlineornot', 'aws', 'azure', 'tencent', 'volcengine']);
assert.strictEqual(providers.length, 24, 'les 24 identités fournisseur restent présentes');
assert.strictEqual(new Set(providers.map((p) => p.id)).size, providers.length, 'ids fournisseurs dupliqués');
for (const p of providers) {
  assert.ok(p.id && p.name && p.statusUrl && p.source?.kind && p.source?.url, `fournisseur incomplet : ${p.id}`);
  assert.ok(GROUPS.includes(p.group), `groupe absent ou inconnu : ${p.id} ${p.group}`);
  assert.ok(kinds.has(p.source.kind), `kind inconnu : ${p.id} ${p.source.kind}`);
  if (p.modelPattern) new RegExp(p.modelPattern);
  if (p.source.kind === 'unavailable') assert.ok(p.source.note, `note manquante : ${p.id}`);
  if (p.source.kind === 'google') assert.ok(p.source.productPrefixes?.length, `productPrefixes manquant : ${p.id}`);
  if (p.source.kind === 'flashcat') assert.ok(p.source.pageId, `pageId manquant : ${p.id}`);
  if (p.source.kind === 'xai') {
    assert.strictEqual(p.id, 'xai', 'seul xAI utilise ce flux RSS');
    assert.strictEqual(p.source.url, 'https://status.x.ai/feed.xml');
    assert.deepStrictEqual(p.source.components, xaiComponents, 'composants xAI déclarés stables et ordonnés');
  }
  // Exception : une page faite uniquement de modèles (modelPattern « . ») change de catalogue
  // trop souvent pour imposer un composant ; « aucun composant » reste une erreur
  if (['incidentio', 'datadog'].includes(p.source.kind)) assert.ok(p.source.pageName && (p.source.requiredComponents?.length || p.modelPattern === '.'), `couverture manquante : ${p.id}`);
  if (p.source.kind === 'checkly') assert.ok(p.source.slug, `slug manquant : ${p.id}`);
  if (p.source.kind === 'aws') assert.ok(p.source.eventsUrl && p.source.servicesUrl && p.source.serviceName, `source aws incomplète : ${p.id}`);
  if (p.source.kind === 'azure') assert.ok(p.source.services?.length, `services manquants : ${p.id}`);
  if (p.source.kind === 'tencent') assert.ok(p.source.regionId && p.source.productIds?.length, `source tencent incomplète : ${p.id}`);
  if (p.source.kind === 'volcengine') assert.ok(p.source.product && p.source.productLabel && p.source.regions?.length, `source volcengine incomplète : ${p.id}`);
  assert.ok(typeof p.scopeEn === 'string' && p.scopeEn, `scopeEn manquant : ${p.id}`);
}
const denied = await read(checkly, cProvider, httpFail(403));
assert.match(denied.collect.error, /accès refusé/);
assert.match(denied.collect.errorEn, /access denied/);
assert.ok(!denied.collect.error.includes('Cloudflare'), '403 seul ne prouve pas un challenge');
const replicateConfig = providers.find((p) => p.id === 'replicate');
assert.strictEqual((await read(statuspage, replicateConfig, okJson(scopedHealthy))).status, 'operationnel');
assert.match(replicateConfig.scope, /sans détail API\/GPU/);

assert.ok(providers.some((p) => p.group === 'eu'), 'au moins un fournisseur européen');

console.log(`OK — ${providers.length} fournisseurs déclarés, tests verts`);

await import('./provider-readers.mjs');

await import('./mistral-probe.mjs');
