import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { computeHealth, FAILING_ALERT_MS } from '../lib/health.mjs';
import { applyAlerts, failingTitle, structureTitle } from '../scripts/alerts.mjs';

const declared = [{ id: 'a', source: { kind: 'statuspage' } }, { id: 'z', source: { kind: 'unavailable' } }];
const t0 = Date.parse('2026-10-06T10:00:00Z');
const doc = (at, providers) => ({ generatedAt: new Date(at).toISOString(), providers });
const ok = (names) => ({ id: 'a', name: 'Alpha', components: names.map((name) => ({ name, status: 'operationnel' })), collect: { state: 'ok', error: null } });
const ko = { id: 'a', name: 'Alpha', components: [], collect: { state: 'error', error: 'réponse HTTP : 503' } };
const z = { id: 'z', name: 'Zed', components: [], collect: { state: 'error', error: 'aucune source' } };

// Premier run : base posée, aucune alerte, sources « unavailable » ignorées
let r = computeHealth(null, doc(t0, [ok(['API', 'Web']), z]), declared);
assert.deepEqual(r.alerts, []);
assert.deepEqual(r.health.providers.a.components, ['API', 'Web']);
assert.equal(r.health.providers.z, undefined, 'source sans requête : jamais d’alerte');

// Structure modifiée : ajout et retrait signalés
r = computeHealth(r.health, doc(t0 + 300_000, [ok(['API', 'Console']), z]), declared);
assert.deepEqual(r.alerts, [{ type: 'structure', id: 'a', name: 'Alpha', added: ['Console'], removed: ['Web'] }]);
const base = r.health;

// Échec : rien avant une heure, une seule alerte ensuite, la base de structure est gardée
r = computeHealth(base, doc(t0 + 600_000, [ko, z]), declared);
assert.deepEqual(r.alerts, []);
assert.equal(r.health.providers.a.failingSince, new Date(t0 + 600_000).toISOString());
assert.deepEqual(r.health.providers.a.components, ['API', 'Console']);
r = computeHealth(r.health, doc(t0 + 600_000 + FAILING_ALERT_MS - 1, [ko, z]), declared);
assert.deepEqual(r.alerts, [], 'moins d’une heure : pas d’alerte');
r = computeHealth(r.health, doc(t0 + 600_000 + FAILING_ALERT_MS, [ko, z]), declared);
assert.equal(r.alerts.length, 1);
assert.equal(r.alerts[0].type, 'failing');
assert.equal(r.alerts[0].error, 'réponse HTTP : 503');
r = computeHealth(r.health, doc(t0 + 600_000 + FAILING_ALERT_MS + 300_000, [ko, z]), declared);
assert.deepEqual(r.alerts, [], 'une seule alerte par épisode');

// Retour : fin d'épisode signalée, sans fausse alerte de structure
r = computeHealth(r.health, doc(t0 + 600_000 + FAILING_ALERT_MS + 600_000, [ok(['API', 'Console']), z]), declared);
assert.deepEqual(r.alerts, [{ type: 'recovered', id: 'a', name: 'Alpha' }]);
assert.equal(r.health.providers.a.failingSince, null);

// Échec bref (non signalé) puis retour : aucune alerte
r = computeHealth(base, doc(t0 + 600_000, [ko, z]), declared);
r = computeHealth(r.health, doc(t0 + 900_000, [ok(['API', 'Console']), z]), declared);
assert.deepEqual(r.alerts, []);

// Mémoire publiée illisible ou d'un autre schéma : traitée comme un premier run
for (const previous of [{}, { schemaVersion: 2, providers: {} }, { schemaVersion: 1, providers: { a: { components: 'x' } } }, 'oops']) {
  assert.deepEqual(computeHealth(previous, doc(t0, [ok(['API'])]), declared).alerts, []);
}

// Les vraies déclarations : tous les fournisseurs « unavailable » sont exclus
const providers = JSON.parse(readFileSync(new URL('../providers.json', import.meta.url), 'utf8'));
const allFailing = doc(t0, providers.map((p) => ({ id: p.id, name: p.name, components: [], collect: { state: 'error', error: 'x' } })));
const first = computeHealth(null, allFailing, providers);
const later = computeHealth(first.health, { ...allFailing, generatedAt: new Date(t0 + FAILING_ALERT_MS).toISOString() }, providers);
assert.ok(!later.alerts.some((a) => ['zhipu', 'baidu-ernie'].includes(a.id)));
assert.equal(later.alerts.length, providers.filter((p) => p.source.kind !== 'unavailable').length);

// Issues : création, commentaire de structure, pas de doublon d'échec, fermeture au retour
const gh = () => {
  const state = { issues: [], comments: [], updates: [], next: 1 };
  const github = {
    paginate: async (fn, args) => (await fn(args)).data,
    rest: { issues: {
      listForRepo: async () => ({ data: state.issues.filter((i) => i.state === 'open') }),
      create: async ({ title, body }) => { const issue = { number: state.next++, title, body, state: 'open' }; state.issues.push(issue); return { data: issue }; },
      createComment: async ({ issue_number, body }) => { state.comments.push([issue_number, body]); },
      update: async ({ issue_number, state: s }) => { state.updates.push([issue_number, s]); state.issues.find((i) => i.number === issue_number).state = s; },
    } },
  };
  return { state, github };
};
const context = { repo: { owner: 'o', repo: 'r' } };
const failing = { type: 'failing', id: 'a', name: 'Alpha', since: '2026-10-06T10:00:00Z', error: 'erreur\n`injectée`' };
const structure = { type: 'structure', id: 'a', name: 'Alpha', added: ['Console'], removed: [] };
const { state, github } = gh();
assert.deepEqual(await applyAlerts({ github, context, alerts: [failing, structure] }), [['created', 1], ['created', 2]]);
assert.equal(state.issues[0].title, failingTitle(failing));
assert.equal(state.issues[1].title, structureTitle(structure));
assert.ok(!state.issues[0].body.includes('\n`injectée`'), 'texte tiers aplati : ni saut de ligne ni accent grave');
assert.deepEqual(await applyAlerts({ github, context, alerts: [failing, structure] }), [['commented', 2]], 'échec déjà ouvert : rien ; structure : commentaire');
assert.deepEqual(await applyAlerts({ github, context, alerts: [{ type: 'recovered', id: 'a', name: 'Alpha' }] }), [['closed', 1]]);
assert.equal(state.issues[0].state, 'closed');
assert.deepEqual(await applyAlerts({ github, context, alerts: [] }), []);
assert.deepEqual(await applyAlerts({ github, context, alerts: [{ type: 'inconnu', id: 'a', name: 'A' }] }), []);

console.log('OK — surveillance : échec prolongé, structure modifiée, issues sans doublon');
