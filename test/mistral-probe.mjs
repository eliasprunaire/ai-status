import assert from 'node:assert/strict';
import * as mistral from '../adapters/mistral-probe.mjs';
import { MISTRAL_PROBE_MODEL } from '../lib/http.mjs';
import { collectAll, buildOutput } from '../lib/collect.mjs';
const provider = { id: 'mistral', name: 'Mistral AI', statusUrl: 'https://status.mistral.ai', source: { kind: 'mistral_probe' } };
const originalFetch = globalThis.fetch;
const originalKey = process.env.MISTRAL_API_KEY;
const key = 'test-only-secret-never-publish';
const result = async () => buildOutput([provider], await collectAll([provider], { mistral_probe: mistral }, async () => { assert.fail('pas de GET public'); }), new Date().toISOString(), { mistral_probe: mistral }).providers[0];
const success = { model: 'ministral-3b-2512', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'OK' } }] };
let calls = 0;
try {
  delete process.env.MISTRAL_API_KEY;
  globalThis.fetch = async () => { assert.fail('sans clé : aucune requête'); };
  assert.equal((await result()).status, 'inconnu');
  process.env.MISTRAL_API_KEY = key;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, 'https://api.mistral.ai/v1/chat/completions');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.deepEqual(JSON.parse(options.body), { model: MISTRAL_PROBE_MODEL, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 8, temperature: 0, stream: false });
    return new Response(JSON.stringify(success), { headers: { 'content-type': 'application/json' } });
  };
  const ok = await result();
  assert.equal(ok.status, 'operationnel');
  assert.equal(ok.components.length, 1);
  assert.equal(calls, 1);
  for (const status of [301, 302, 307, 308, 400, 401, 403, 404, 429, 500, 502, 503]) {
    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response(key, { status, headers: { location: 'https://untrusted.test', 'content-type': 'text/plain' } }); };
    const r = await result();
    assert.equal(calls, 1, 'ni suivi de redirection ni nouvelle tentative');
    assert.equal(r.status, status >= 500 ? 'degradation' : 'inconnu');
    assert.ok(!JSON.stringify(r).includes(key));
    assert.equal(r.incidents.length, 0, 'pas de faux incident officiel');
  }
  for (const body of [key, {}, { ...success, model: 'another-model' }, { ...success, choices: [] }, { ...success, choices: [{ finish_reason: 'length', message: { role: 'assistant', content: 'OK' } }] }, { ...success, choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '' } }] }]) {
    globalThis.fetch = async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const r = await result();
    assert.equal(r.status, 'inconnu');
    assert.ok(!JSON.stringify(r).includes(key));
  }
  for (const err of [new Error(key), new DOMException(key, 'AbortError')]) {
    globalThis.fetch = async () => { throw err; };
    const r = await result();
    assert.equal(r.status, 'inconnu');
    assert.ok(!JSON.stringify(r).includes(key));
  }
  globalThis.fetch = async () => new Response('x'.repeat(65537), { headers: { 'content-type': 'application/json' } });
  assert.equal((await result()).status, 'inconnu');

  // Réutilisation de l'observation publiée : au plus une sonde facturée par fenêtre de 30 min
  const reuseUrl = 'https://site.test/data/status.json';
  const reuseProvider = { ...provider, source: { kind: 'mistral_probe', reuse: { url: reuseUrl, maxAgeMinutes: 30 } } };
  const run = async (get) => buildOutput([reuseProvider], await collectAll([reuseProvider], { mistral_probe: mistral }, get), new Date().toISOString(), { mistral_probe: mistral }).providers[0];
  const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
  const previousDoc = async (fetchImpl, minutes) => {
    globalThis.fetch = fetchImpl;
    const doc = JSON.parse(JSON.stringify(buildOutput([provider], await collectAll([provider], { mistral_probe: mistral }, async () => { assert.fail('pas de GET'); }), new Date().toISOString(), { mistral_probe: mistral })));
    doc.providers[0].collectedAt = ago(minutes);
    return doc;
  };
  const healthy = async () => new Response(JSON.stringify(success), { headers: { 'content-type': 'application/json' } });
  const countingFetch = () => { calls = 0; globalThis.fetch = async () => { calls++; return healthy(); }; };

  const recent = await previousDoc(healthy, 10);
  let requested;
  countingFetch();
  let r = await run(async (url) => { requested = url; return recent; });
  assert.equal(calls, 0, 'observation saine de 10 min : aucun appel Mistral');
  assert.equal(r.status, 'operationnel');
  assert.equal(r.collectedAt, recent.providers[0].collectedAt, 'l’heure de la sonde d’origine est conservée');
  assert.ok(requested.startsWith(`${reuseUrl}?t=`), 'paramètre unique contre le cache du CDN');

  for (const [label, doc, expectedCalls] of [
    ['trop ancienne (31 min)', await previousDoc(healthy, 31), 1],
    ['heure dans le futur', await previousDoc(healthy, -5), 1],
    ['dégradation précédente', await previousDoc(async () => new Response('x', { status: 500 }), 5), 1],
    ['échec précédent', await previousDoc(async () => { throw new Error('réseau'); }, 5), 1],
    ['document invalide', { schemaVersion: 2 }, 1],
  ]) {
    countingFetch();
    r = await run(async () => doc);
    assert.equal(calls, expectedCalls, `${label} : nouvelle sonde`);
    assert.equal(r.status, 'operationnel');
    assert.ok(Date.now() - Date.parse(r.collectedAt) < 60_000, `${label} : heure de la nouvelle sonde`);
  }

  countingFetch();
  r = await run(async () => { throw new Error('site injoignable'); });
  assert.equal(calls, 1, 'lecture impossible : on sonde');
  assert.equal(r.status, 'operationnel');

  // Une observation récente mais sans clé n'est jamais publiée comme saine
  delete process.env.MISTRAL_API_KEY;
  countingFetch();
  r = await run(async () => recent);
  assert.equal(calls, 0);
  assert.equal(r.status, 'inconnu');
  process.env.MISTRAL_API_KEY = key;

  // Le runner ignore une heure d'observation postérieure à l'heure courante
  const future = { collect: async () => ({ indicator: 'operationnel', components: [], incidents: [], maintenances: [], collectedAt: new Date(Date.now() + 3_600_000).toISOString() }) };
  const [settledFuture] = await collectAll([provider], { mistral_probe: future }, async () => { assert.fail('pas de GET'); });
  assert.ok(Date.parse(settledFuture.value.collectedAt) <= Date.now(), 'heure future remplacée par l’heure courante');
} finally {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.MISTRAL_API_KEY;
  else process.env.MISTRAL_API_KEY = originalKey;
}
console.log('OK — sonde Mistral bornée, clé isolée, erreurs sans secret et réutilisation sous 30 min');
