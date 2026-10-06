import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as datadog from '../adapters/datadog.mjs';
import * as incidentio from '../adapters/incidentio.mjs';
import { collectAll, buildOutput } from '../lib/collect.mjs';
import { validateStatusDocument } from '../public/status-contract.js';
const fixture = (name) => readFileSync(new URL(`fixtures/${name}`, import.meta.url), 'utf8');
// Fixtures observées le 12/09/2026 : https://status.openrouter.ai/config.json et https://status.perplexity.com/
// Datadog conserve le document public ; incident.io conserve le résumé réel dans une enveloppe Flight réduite
// Les variations d’incidents actifs, de maintenances, de fragmentation et de références sont synthétiques
const dd = JSON.parse(fixture('datadog-openrouter.json'));
const html = fixture('incidentio-perplexity.html');
const p = (kind, name, url) => ({ id: kind, name, group: 'us', scope: 'official services', scopeEn: 'official services', statusUrl: url, source: { kind, url, pageName: name } });
const dp = p('datadog', 'OpenRouter', 'https://status.openrouter.ai');
dp.source.domainPrefix = 'openrouter';
const ip = p('incidentio', 'Perplexity', 'https://status.perplexity.com');
const read = async (mod, provider, body) => {
  const doc = buildOutput([provider], await collectAll([provider], { [provider.source.kind]: mod }, async () => body), new Date().toISOString(), { [provider.source.kind]: mod });
  assert.ok(validateStatusDocument(doc, [provider]));
  return doc.providers[0];
};
assert.equal((await read(datadog, dp, dd)).status, 'operationnel');
assert.equal((await read(datadog, dp, dd)).components.length, 7);
assert.equal((await read(incidentio, ip, html)).status, 'operationnel');
assert.equal((await read(incidentio, ip, html)).components.length, 3);
const changed = structuredClone(dd);
changed.components[0].components[0].status = 'degraded';
changed.components[1].status = 'unrecognized';
assert.equal((await read(datadog, dp, changed)).status, 'degradation');
for (const patch of [{ incidents: undefined }, { maintenances: undefined }, { components: [] }, { name: 'Other' }, { next: 'page2' }]) {
  assert.equal((await read(datadog, dp, { ...dd, ...patch })).status, 'inconnu');
}
const incident = { ...dd.incidents[0], resolved: false, resolvedDate: '', currentStatus: 'investigating' };
assert.notEqual((await read(datadog, dp, { ...dd, incidents: [incident] })).status, 'operationnel');
assert.equal((await read(datadog, dp, { ...dd, incidents: [{ ...incident, resolved: true }] })).status, 'inconnu');
assert.equal((await read(datadog, dp, { ...dd, incidents: [{ ...incident, deletedAt: '2026-09-12T06:00:00Z' }] })).incidents.length, 0);
for (const state of ['scheduled', 'in_progress', 'completed', 'canceled']) {
  const maintenance = { id: 'maint', title: 'Upgrade', currentStatus: state, startDate: '2026-09-12T00:00:00Z', ...(state === 'completed' ? { completedDate: '2026-09-12T01:00:00Z' } : {}), componentsAffected: [dd.components[1]] };
  assert.equal((await read(datadog, dp, { ...dd, maintenances: [maintenance] })).status, state === 'in_progress' ? 'maintenance' : 'operationnel');
}
const summary = incidentio.parseSummary(html);
const encode = (s) => `<script>self.__next_f.push(${JSON.stringify([1, '3:' + JSON.stringify(['$', 'div', null, { summary: s }]) + '\n'])})</script>`;
for (const patch of [{ affected_components: undefined }, { ongoing_incidents: undefined }, { scheduled_maintenances: undefined }, { components: [] }, { public_url: 'https://other.test' }]) {
  assert.equal((await read(incidentio, ip, encode({ ...summary, ...patch }))).status, 'inconnu');
}
const affected = [{ component_id: summary.components[0].id, status: 'partial_outage' }];
assert.equal((await read(incidentio, ip, encode({ ...summary, affected_components: affected }))).status, 'degradation');
const ioIncident = { id: 'incident', name: 'Outage', status_page_id: summary.id, type: 'incident', status: 'investigating', published_at: '2026-09-12T06:00:00Z', affected_components: affected, component_impacts: [], updates: [] };
assert.equal((await read(incidentio, ip, encode({ ...summary, affected_components: affected, ongoing_incidents: [ioIncident] }))).incidents.length, 1);
assert.equal((await read(incidentio, ip, encode({ ...summary, ongoing_incidents: [{ ...ioIncident, status: 'resolved' }] }))).status, 'inconnu');
for (const state of ['maintenance_scheduled', 'maintenance_in_progress']) {
  const event = { ...ioIncident, type: 'maintenance', status: state };
  const s = { ...summary, ...(state === 'maintenance_scheduled' ? { scheduled_maintenances: [event] } : { ongoing_incidents: [event] }) };
  assert.equal((await read(incidentio, ip, encode(s))).status, state === 'maintenance_scheduled' ? 'operationnel' : 'maintenance');
}
const raw = '3:' + JSON.stringify(['$', 'div', null, { summary }]) + '\n';
const fragmented = [raw.slice(0, 137), raw.slice(137)].map(s => `<script>self.__next_f.push(${JSON.stringify([1, s])})</script>`).join('');
assert.deepEqual(incidentio.parseSummary(fragmented), summary);
assert.throws(() => incidentio.parseSummary(encode('$missing')));
assert.equal((await read(incidentio, ip, '<html>challenge</html>')).status, 'inconnu');
const wrapped = (stream) => `<script>self.__next_f.push(${JSON.stringify([1, stream])})</script>`;
assert.deepEqual(incidentio.parseSummary(wrapped(':HL["style.css","style"]\n' + raw)), summary);
assert.deepEqual(incidentio.parseSummary(wrapped('a:T5,été' + raw)), summary);
assert.deepEqual(incidentio.parseSummary(wrapped('a:' + JSON.stringify(summary) + '\n3:["$","div",null,{"summary":"$a"}]\n')), summary);
assert.throws(() => incidentio.parseSummary(wrapped('a:"$a"\n3:["$","div",null,{"summary":"$a"}]\n')));
assert.throws(() => incidentio.parseSummary(wrapped(raw + raw)));
assert.throws(() => incidentio.parseSummary(wrapped(raw.slice(0, -1))));
const duplicateDD = structuredClone(dd);
duplicateDD.components.push(duplicateDD.components[1]);
assert.equal((await read(datadog, dp, duplicateDD)).status, 'inconnu');
assert.equal((await read(datadog, dp, { ...dd, incidents: [{ ...incident, componentsAffected: [{ id: 'missing', name: 'Missing', status: 'degraded' }] }] })).status, 'inconnu');
assert.equal((await read(datadog, dp, { ...dd, incidents: [{ ...dd.incidents[0], resolvedDate: '2000-01-01T00:00:00Z' }] })).status, 'inconnu');
assert.equal((await read(incidentio, ip, encode({ ...summary, components: [...summary.components, summary.components[0]] }))).status, 'inconnu');
assert.equal((await read(incidentio, ip, encode({ ...summary, affected_components: [{ component_id: 'missing', status: 'full_outage' }] }))).status, 'inconnu');
assert.equal((await read(incidentio, ip, encode({ ...summary, ongoing_incidents: [{ ...ioIncident, updates: [{ published_at: '2026-09-12T06:01:00Z', to_status: 'resolved' }] }] }))).status, 'inconnu');
const actualProviders = JSON.parse(readFileSync(new URL('../providers.json', import.meta.url), 'utf8'));
for (const [id, mod, body] of [['perplexity', incidentio, html], ['openrouter', datadog, dd]]) {
  const provider = actualProviders.find(p => p.id === id);
  assert.equal((await read(mod, provider, body)).collect.state, 'ok');
  const missing = id === 'openrouter' ? { ...body, components: body.components.slice(0, 1) } : encode({ ...summary, components: summary.components.slice(1), structure: { ...summary.structure, items: summary.structure.items.slice(1) } });
  assert.equal((await read(mod, provider, missing)).status, 'inconnu');
  const failed = buildOutput([provider], await collectAll([provider], { [provider.source.kind]: mod }, async () => { throw new Error('network'); }), new Date().toISOString(), { [provider.source.kind]: mod });
  assert.equal(failed.providers[0].status, 'inconnu');
}

// incident.io via l'endpoint JSON /proxy/<hôte> (fixtures réelles du 2026-10-06). summary.json de
// ces pages tronque à 25 composants et omet les incidents : le proxy doit tout restituer
const proxyProvider = (id, url, pageName, requiredComponents) => ({ id, name: id, group: 'us', scope: 's', scopeEn: 's', statusUrl: url, source: { kind: 'incidentio', format: 'proxy', url, pageName, requiredComponents } });
const openaiProxy = JSON.parse(fixture('incidentio-proxy-openai.json'));
const op = proxyProvider('openai', 'https://status.openai.com', 'OpenAI', ['Codex Web', 'Codex API']);
let requested;
const o1 = buildOutput([op], await collectAll([op], { incidentio }, async (url) => { requested = url; return openaiProxy; }), new Date().toISOString(), { incidentio }).providers[0];
assert.equal(requested, 'https://status.openai.com/proxy/status.openai.com');
assert.equal(o1.status, 'operationnel');
assert.equal(o1.components.length, 36, '36 composants affichés (le 37e est hors structure), au lieu des 25 de summary.json');
assert.ok(o1.components.some((c) => c.name === 'Codex Web'), 'Codex couvert');
assert.deepEqual(o1.components.filter((c) => c.name.endsWith('Login')).map((c) => c.name), ['APIs · Login', 'ChatGPT · Login'], 'doublon de nom préfixé par son groupe');
assert.ok(!o1.components.some((c) => c.name === 'ChatGPT Atlas'), 'composant absent de la structure publique : non suivi');

// Incident en cours sur un composant de groupe
const live = structuredClone(openaiProxy);
const codex = live.summary.components.find((c) => c.name === 'Codex Web');
const at = new Date(Date.now() - 600_000).toISOString();
live.summary.affected_components = [{ component_id: codex.id, status: 'partial_outage' }];
live.summary.ongoing_incidents = [{ id: 'INC1', name: 'Codex errors', status: 'investigating', type: 'incident', status_page_id: live.summary.id, published_at: at, updates: [{ published_at: at, to_status: 'investigating' }], affected_components: [{ component_id: codex.id, status: 'partial_outage' }], component_impacts: [{ component_id: codex.id, status: 'partial_outage', start_at: at }] }];
const o2 = await read(incidentio, op, live);
assert.equal(o2.status, 'degradation');
assert.deepEqual(o2.incidents.map((i) => i.title), ['Codex errors']);
assert.deepEqual(o2.incidents[0].components, ['Codex Web']);

// Groq : maintenance « planifiée » dont la fenêtre (component_impacts) est passée depuis 2025
const groqProxy = JSON.parse(fixture('incidentio-proxy-groq.json'));
const gp = proxyProvider('groq', 'https://groqstatus.com', groqProxy.summary.name, ['API']);
const g1 = await read(incidentio, gp, groqProxy);
assert.equal(g1.maintenances.length, 0, 'maintenance périmée écartée');
const future = structuredClone(groqProxy);
future.summary.scheduled_maintenances[0].component_impacts[0].start_at = new Date(Date.now() + 86_400_000).toISOString();
future.summary.scheduled_maintenances[0].component_impacts[0].end_at = new Date(Date.now() + 90_000_000).toISOString();
const g2 = await read(incidentio, gp, future);
assert.equal(g2.maintenances.length, 1, 'maintenance future affichée avec ses dates');
assert.ok(g2.maintenances[0].scheduledFor && g2.maintenances[0].scheduledUntil);
for (const broken of [{ summary: null }, [], { summary: { ...groqProxy.summary, public_url: 'https://evil.test/' } }]) {
  assert.equal((await read(incidentio, gp, broken)).status, 'inconnu');
}
console.log('OK — lecteurs incident.io et Datadog via runner et contrat');
