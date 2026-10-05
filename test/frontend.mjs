import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { MAX_STATUS_BYTES } from '../public/status-contract.js';
import { BUILD_INFO } from '../public/build-info.js';

const NOW = Date.parse('2026-09-04T08:00:00Z');
const MINUTE = 60_000;
const files = {
  '/': ['text/html; charset=utf-8', readFileSync(new URL('../public/index.html', import.meta.url))],
  '/build-info.js': ['text/javascript; charset=utf-8', readFileSync(new URL('../public/build-info.js', import.meta.url))],
  '/app.js': ['text/javascript; charset=utf-8', readFileSync(new URL('../public/app.js', import.meta.url))],
  '/status-contract.js': ['text/javascript; charset=utf-8', readFileSync(new URL('../public/status-contract.js', import.meta.url))],
  '/style.css': ['text/css; charset=utf-8', readFileSync(new URL('../public/style.css', import.meta.url))],
};

const statusDoc = (generatedAt, name = 'Fournisseur test') => ({
  schemaVersion: 2,
  generatedAt,
  labels: {
    operationnel: 'Opérationnel', degradation: 'Dégradation', incident_majeur: 'Incident majeur',
    maintenance: 'Maintenance', indisponible: 'Indisponible', inconnu: 'Non vérifié',
  },
  labelsEn: {
    operationnel: 'Operational', degradation: 'Degraded', incident_majeur: 'Major incident',
    maintenance: 'Maintenance', indisponible: 'Unavailable', inconnu: 'Unverified',
  },
  summary: {
    worst: 'operationnel',
    counts: { operationnel: 1, degradation: 0, incident_majeur: 0, maintenance: 0, indisponible: 0, inconnu: 0 },
    activeIncidents: 0,
    activeMaintenances: 0,
  },
  providers: [{
    id: 'test', name, group: 'us', scope: 'API de test', scopeEn: 'Test API', statusUrl: 'https://example.com/status',
    status: 'operationnel', reason: 'aucun incident déclaré', reasonEn: 'no incident reported', sourceText: null,
    collectedAt: generatedAt,
    collect: { state: 'ok', method: 'statuspage', error: null, errorEn: null },
    components: [{ name: 'API', kind: 'service', status: 'operationnel' }],
    incidents: [], maintenances: [],
  }],
});

let responses = [];
let requests = 0;
const held = [];

const server = createServer((req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/data/status.json') {
    const response = responses[Math.min(requests++, responses.length - 1)];
    if (response?.hold) {
      held.push({ res, body: response.body });
      return;
    }
    res.writeHead(response?.status ?? 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(response?.body ?? {}));
    return;
  }
  const file = files[path];
  if (!file) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-type': file[0] });
  res.end(file[1]);
});

const waitForRequests = async (count) => {
  for (let i = 0; i < 100 && requests < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(requests, count);
};

const releaseHeld = (body) => {
  const pending = held.shift();
  assert.ok(pending, 'une requête retenue était attendue');
  pending.res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  pending.res.end(JSON.stringify(body ?? pending.body));
};

let browser;
try {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  browser = await chromium.launch({ headless: true });

  async function scenario(sequence, run, options = {}) {
    responses = sequence;
    requests = 0;
    held.length = 0;
    const context = await browser.newContext(options);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.clock.install({ time: NOW });
    try {
      await page.goto(`http://127.0.0.1:${port}/`);
      await page.locator('#refresh[aria-busy="false"]').waitFor();
      await run(page);
      assert.equal(await page.locator('#build-version').textContent(), `${BUILD_INFO.version} · ${BUILD_INFO.sha.slice(0, 7)}`);
      assert.equal(await page.locator('#build-version').getAttribute('href'), `https://github.com/eliasprunaire/ai-status/commit/${BUILD_INFO.sha}`);
      assert.deepEqual(pageErrors, [], 'aucune erreur JavaScript dans la page');
    } finally {
      for (const pending of held.splice(0)) pending.res.destroy();
      await context.close();
    }
  }

  const old = statusDoc(new Date(NOW - 3 * 60 * MINUTE).toISOString(), 'Ancien fournisseur');
  const fresh = statusDoc(new Date(NOW + 30 * MINUTE).toISOString(), 'Nouveau fournisseur');

  await scenario([{ body: old }, { body: fresh }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    await page.locator('#stale').waitFor();
    await page.getByRole('searchbox').fill('nouveau');
    await page.locator('#sort').selectOption('name');
    await page.clock.runFor(30 * MINUTE);
    await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
    assert.equal(await page.getByRole('searchbox').inputValue(), 'nouveau');
    assert.equal(await page.locator('#sort').inputValue(), 'name');
    assert.equal(requests, 2);
    assert.equal(await page.locator('#stale').isHidden(), true);
  });

  await scenario([{ body: old }, { body: fresh }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    const refresh = page.getByRole('button', { name: 'Rafraîchir' });
    await refresh.focus();
    await page.keyboard.press('Enter');
    await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
    assert.match(await page.locator('#refresh-status').textContent(), /Données actualisées/);
    assert.equal(requests, 2, 'le bouton ignore l’échéance de 30 minutes');
  });

  await scenario([{ status: 500 }, { body: fresh }], async (page) => {
    await page.getByText('Données indisponibles', { exact: true }).waitFor();
    await page.locator('#refresh-error').waitFor();
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
    assert.equal(await page.locator('#refresh-error').isHidden(), true);
  });

  await scenario([{ status: 500 }, { body: fresh }], async (page) => {
    await page.getByText('Données indisponibles', { exact: true }).waitFor();
    await page.locator('#refresh-error').waitFor();
    await page.getByRole('button', { name: 'Rafraîchir' }).waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('button', { name: 'Rafraîchir' }).isEnabled(), true);
    await page.clock.runFor(30 * MINUTE);
    await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
    assert.equal(requests, 2);
  });

  await scenario([{ body: old }, { status: 500 }, { body: { schemaVersion: 2, generatedAt: new Date(NOW).toISOString(), providers: [] } }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.locator('#refresh-error').waitFor();
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.locator('#refresh-error').waitFor();
    await waitForRequests(3);
    await page.locator('#refresh[aria-busy="false"]').waitFor();
    assert.equal(await page.getByText('Ancien fournisseur', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Nouveau fournisseur', { exact: true }).count(), 0);
  });

  const current = statusDoc(new Date(NOW).toISOString(), 'Données actuelles');
  const older = statusDoc(new Date(NOW - MINUTE).toISOString(), 'Données régressives');
  await scenario([{ body: current }, { body: older }], async (page) => {
    await page.getByText('Données actuelles', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.locator('#refresh-error').waitFor();
    assert.equal(await page.getByText('Données actuelles', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Données régressives', { exact: true }).count(), 0);
  });

  const inconsistent = structuredClone(fresh);
  inconsistent.summary.counts.operationnel = 2;
  await scenario([{ body: current }, { body: inconsistent }], async (page) => {
    await page.getByText('Données actuelles', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.locator('#refresh-error').waitFor();
    assert.equal(await page.getByText('Données actuelles', { exact: true }).count(), 1);
  });

  const links = statusDoc(new Date(NOW).toISOString(), 'Liens filtrés');
  links.providers[0].status = 'degradation';
  links.providers[0].reason = '1 incident en cours';
  links.providers[0].reasonEn = '1 incident in progress';
  links.providers[0].components = [{ name: 'Composant \u202E piégé', kind: 'service', status: 'degradation' }];
  links.providers[0].incidents = [
    { title: 'Lien \u202E sûr', status: 'investigating', impact: null, startedAt: null, updatedAt: null, url: 'https://example.com/incidents/ok', components: ['Composant \u202E piégé'] },
  ];
  links.summary.worst = 'degradation';
  links.summary.counts.operationnel = 0;
  links.summary.counts.degradation = 1;
  links.summary.activeIncidents = 1;
  await scenario([{ body: links }], async (page) => {
    await page.getByRole('heading', { name: 'Liens filtrés', exact: true }).waitFor();
    await page.locator('#test details').evaluate((details) => { details.open = true; });
    assert.equal(await page.locator('#test .incident-link').count(), 1);
    assert.equal(await page.locator('#test .incident-link').getAttribute('href'), 'https://example.com/incidents/ok');
    assert.equal(await page.locator('#test .incident-link').getAttribute('rel'), 'noopener noreferrer');
    assert.equal(await page.locator('#test .incident-title').first().evaluate((node) => node.tagName), 'BDI');
    assert.equal(await page.locator('#test .incident-title').first().getAttribute('dir'), 'auto');
    assert.equal(await page.locator('#test .incident-meta bdi').getAttribute('dir'), 'auto');
    assert.equal(await page.locator('#test .comp-name').evaluate((node) => node.tagName), 'BDI');
    assert.equal(await page.locator('#ongoing .ongoing-comps bdi').getAttribute('dir'), 'auto');
    assert.equal(await page.getByRole('link', { name: 'page officielle' }).getAttribute('rel'), 'noopener noreferrer');
  });

  const longText = 'x'.repeat(60_000);
  const longDoc = statusDoc(new Date(NOW).toISOString(), 'Texte public borné');
  longDoc.providers[0].status = 'degradation';
  longDoc.providers[0].reason = '1 incident en cours';
  longDoc.providers[0].reasonEn = '1 incident in progress';
  longDoc.providers[0].incidents = [{ title: longText, status: 'investigating', impact: null, startedAt: null, updatedAt: null, url: null, components: [] }];
  longDoc.summary = { worst: 'degradation', counts: { operationnel: 0, degradation: 1, incident_majeur: 0, maintenance: 0, indisponible: 0, inconnu: 0 }, activeIncidents: 1, activeMaintenances: 0 };
  for (const width of [390, 1440]) {
    await scenario([{ body: longDoc }], async (page) => {
      await page.getByRole('heading', { name: 'Texte public borné', exact: true }).waitFor();
      await page.locator('#test details').evaluate((details) => { details.open = true; });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px texte sans espace`);
    }, { viewport: { width, height: 900 } });
  }

  const oversized = statusDoc(new Date(NOW).toISOString(), 'Document excessif');
  oversized.providers[0].components = Array.from({ length: 5_000 }, (_, index) => ({
    name: `${index}-${'x'.repeat(2_100)}`,
    kind: 'service',
    status: 'operationnel',
  }));
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > MAX_STATUS_BYTES);
  await scenario([{ body: oversized }], async (page) => {
    await page.getByText('Données indisponibles', { exact: true }).waitFor();
    await page.locator('#refresh-error').waitFor();
    assert.equal(await page.getByText('Document excessif', { exact: true }).count(), 0);
  });

  await scenario([{ body: old }, { hold: true, body: fresh }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    const refresh = page.getByRole('button', { name: 'Rafraîchir' });
    const click = refresh.click();
    await waitForRequests(2);
    assert.equal(await refresh.isDisabled(), true);
    assert.equal(await refresh.getAttribute('aria-busy'), 'true');
    await page.evaluate(() => {
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(requests, 2, 'tous les déclencheurs partagent le même verrou');
    releaseHeld();
    await click;
    await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
    assert.equal(await refresh.isEnabled(), true);
    assert.equal(await refresh.getAttribute('aria-busy'), 'false');
  });

  await scenario([{ body: old }, { hold: true }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    await page.clock.pauseAt(await page.evaluate(() => Date.now()));
    const refresh = page.getByRole('button', { name: 'Rafraîchir' });
    const click = refresh.click();
    await waitForRequests(2);
    await page.clock.runFor(14_999);
    assert.equal(await refresh.isDisabled(), true);
    await page.clock.runFor(1);
    await click;
    await page.locator('#refresh-error').waitFor();
    assert.equal(await refresh.isEnabled(), true);
    assert.equal(await page.getByText('Ancien fournisseur', { exact: true }).count(), 1);
  });

  await scenario([{ body: old }, { body: fresh }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    const currentTime = await page.evaluate(() => Date.now());
    await page.clock.setSystemTime(currentTime + 30 * MINUTE);
    assert.equal(requests, 1, 'changer seulement l’heure ne déclenche pas le minuteur');
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
    assert.equal(requests, 2);
  });

  await scenario([{ body: old }, { body: statusDoc(old.generatedAt, 'Contenu incohérent') }], async (page) => {
    await page.getByText('Ancien fournisseur', { exact: true }).waitFor();
    await page.locator('.card details').evaluate((details) => { details.open = true; });
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.locator('#refresh[aria-busy="false"]').waitFor();
    assert.equal(await page.getByText('Ancien fournisseur', { exact: true }).count(), 1);
    assert.equal(await page.getByText('Contenu incohérent', { exact: true }).count(), 0);
    assert.equal(await page.locator('.card details').getAttribute('open'), '');
  });

  const unchanged = statusDoc(new Date(NOW).toISOString(), 'Données inchangées');
  await scenario([{ body: unchanged }, { body: unchanged }], async (page) => {
    await page.getByText('Données inchangées', { exact: true }).waitFor();
    await page.clock.runFor(11 * MINUTE);
    assert.match(await page.locator('#collected-at').textContent(), /il y a 11 min/);
    await page.getByRole('button', { name: 'Rafraîchir' }).click();
    await page.locator('#refresh[aria-busy="false"]').waitFor();
    const freshness = await page.locator('#collected-at').textContent();
    assert.match(freshness, /vérifié .+ \(à l’instant\)/);
    assert.match(freshness, /^Collecte .+ \(il y a 11 min\)/);
    assert.match(await page.locator('#refresh-status').textContent(), /Aucune nouvelle collecte publiée : dernière il y a 11 min/);
    assert.equal(await page.locator('#refresh-status').isVisible(), true);
    await page.clock.runFor(75 * 1000);
    assert.match(await page.locator('#collected-at').textContent(), /vérifié .+ \(il y a 1 min\)/, 'l’âge de la vérification avance');
    assert.equal(await page.locator('#refresh-status').textContent(), '');
  });

  for (const width of [390, 1440]) {
    await scenario([{ body: fresh }], async (page) => {
      await page.getByText('Nouveau fournisseur', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
    }, { viewport: { width, height: 900 } });
  }

  console.log('OK — actualisation navigateur fiable');

  // Bilingue : FR → EN → FR sans rechargement ni requête ; textes visibles et accessibles ;
  // « Statut global » pour une carte sans composant ; filtres, recherche et cartes ouvertes conservés
  const bilingual = statusDoc(new Date(NOW).toISOString(), 'Fournisseur test');
  bilingual.providers.push({
    id: 'global', name: 'Alibaba Cloud', group: 'cn', scope: 'Statut global du cloud', scopeEn: 'Global cloud status', statusUrl: 'https://example.com/global',
    status: 'degradation', reason: '1 incident en cours', reasonEn: '1 incident in progress', sourceText: null, collectedAt: bilingual.generatedAt,
    collect: { state: 'ok', method: 'alibaba', methodLabel: 'API Alibaba Cloud', methodLabelEn: 'Alibaba Cloud API', error: null, errorEn: null }, components: [],
    incidents: [{ title: 'Network issue', status: 'en cours', impact: null, startedAt: bilingual.generatedAt, updatedAt: null, url: null, components: [] }], maintenances: [],
  });
  bilingual.summary = { worst: 'degradation', counts: { operationnel: 1, degradation: 1, incident_majeur: 0, maintenance: 0, indisponible: 0, inconnu: 0 }, activeIncidents: 1, activeMaintenances: 0 };
  // Les champs labels du JSON sont conservés pour le contrat mais ignorés : la page affiche ceux du module
  bilingual.labels.degradation = 'Bidon';
  bilingual.labelsEn.degradation = 'Bogus';
  await scenario([{ body: bilingual }], async (page) => {
    await page.getByText('Fournisseur test', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'fr');
    assert.equal(await page.title(), 'État des fournisseurs IA');
    assert.equal(await page.locator('#global .card-count').textContent(), 'Statut global');
    assert.equal(await page.locator('#global .card-reason').textContent(), '1 incident en cours');
    assert.equal(await page.locator('#global .card-state').textContent(), 'Dégradation', 'libellé du contrat, pas du JSON');
    assert.match(await page.locator('#global .meta').textContent(), /Lu via API Alibaba Cloud/);
    assert.equal(await page.locator('#g-cn').textContent(), 'Fournisseurs · Chine');
    // État à conserver : recherche vide, filtre « dégradation », tri par nom, carte ouverte
    await page.locator('#sort').selectOption('name');
    await page.locator('.chip[data-status="degradation"]').click();
    await page.locator('#global details').evaluate((details) => { details.open = true; });
    assert.equal(await page.locator('.card').count(), 1);

    const en = page.getByRole('button', { name: 'Anglais' });
    await en.focus();
    await page.keyboard.press('Enter');
    assert.equal(requests, 1, 'le changement de langue ne fait aucune requête');
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'en');
    assert.equal(await page.title(), 'AI provider status');
    assert.equal(await page.getByRole('button', { name: 'English' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: 'French' }).getAttribute('aria-pressed'), 'false');
    assert.equal(await page.getByRole('link', { name: 'Skip to the provider list' }).count(), 1);
    assert.equal(await page.getByRole('button', { name: 'Refresh' }).count(), 1);
    assert.equal(await page.getByRole('searchbox', { name: 'Search a provider, a model or a service' }).count(), 1);
    assert.equal(await page.getByRole('group', { name: 'Filter by state' }).count(), 1);
    assert.equal(await page.locator('#ongoing-title').textContent(), 'Ongoing');
    assert.match(await page.locator('#overall').textContent(), /Degraded at 1 provider/);
    assert.equal(await page.locator('#global .card-count').textContent(), 'Global status');
    assert.equal(await page.locator('#global .card-reason').textContent(), '1 incident in progress');
    assert.equal(await page.locator('#global .card-scope').textContent(), 'Global cloud status');
    assert.equal(await page.locator('#global .card-state').textContent(), 'Degraded', 'libellé du contrat, pas du JSON');
    assert.equal(await page.locator('#g-cn').textContent(), 'Providers · China');
    assert.match(await page.locator('#collected-at').textContent(), /^Collected .* · checked /);
    assert.equal(await page.locator('.foot-title').first().textContent(), 'Collection');
    assert.match(await page.locator('#global .meta').textContent(), /Read via Alibaba Cloud API/, 'libellé de famille fourni par le collecteur');
    assert.equal(await page.locator('#global .incident-title').getAttribute('lang'), 'en', 'titre brut de la source : langue détectée, jamais traduit');
    // État conservé : filtre, tri, carte ouverte
    assert.equal(await page.locator('.card').count(), 1, 'filtre conservé');
    assert.equal(await page.locator('.chip[data-status="degradation"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#sort').inputValue(), 'name');
    assert.equal(await page.locator('#global details').getAttribute('open'), '', 'carte ouverte conservée');
    assert.equal(await page.evaluate(() => localStorage.getItem('lang')), 'en');

    await page.locator('.chip[data-status="degradation"]').click();
    await page.getByRole('searchbox').fill('test');
    assert.equal(await page.locator('.card').count(), 1);
    await page.getByRole('button', { name: 'French' }).click();
    assert.equal(requests, 1);
    assert.equal(await page.evaluate(() => document.documentElement.lang), 'fr');
    assert.equal(await page.getByRole('button', { name: 'Français' }).getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('#global').count(), 0, 'recherche conservée');
    assert.equal(await page.getByRole('searchbox').inputValue(), 'test');
    assert.equal(await page.locator('#test .card-count').textContent(), '1 composant');
    assert.match(await page.locator('#test .meta').textContent(), /Lu via statuspage ·/, 'sans libellé : repli sur l’id machine');
    assert.equal(await page.locator('#result-count').textContent(), '1 fournisseur sur 2');
    assert.equal(await page.evaluate(() => localStorage.getItem('lang')), 'fr');
  });

  // Choix mémorisé : une page rouverte en anglais reste en anglais, y compris en échec de chargement
  await scenario([{ status: 500 }, { body: bilingual }], async (page) => {
    await page.getByText('Data unavailable', { exact: true }).waitFor();
    assert.match(await page.locator('#refresh-error').textContent(), /Refresh failed/);
    await page.getByRole('button', { name: 'French' }).click();
    await page.getByText('Données indisponibles', { exact: true }).waitFor();
    assert.match(await page.locator('#refresh-error').textContent(), /Actualisation impossible/);
    await page.getByRole('button', { name: 'Anglais' }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await page.getByText('Fournisseur test', { exact: true }).waitFor();
    assert.equal(await page.locator('#test .card-scope').textContent(), 'Test API');
  }, { storageState: { cookies: [], origins: [{ origin: `http://127.0.0.1:${port}`, localStorage: [{ name: 'lang', value: 'en' }] }] } });

  for (const width of [390, 1440]) {
    for (const language of ['fr', 'en']) {
      await scenario([{ body: bilingual }], async (page) => {
        await page.getByText('Fournisseur test', { exact: true }).waitFor();
        if (language === 'en') await page.getByRole('button', { name: 'Anglais' }).click();
        await page.locator('#global details').evaluate((details) => { details.open = true; });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, `${width}px ${language}`);
        assert.equal(await page.getByRole('button', { name: language === 'en' ? 'English' : 'Français' }).isVisible(), true);
      }, { viewport: { width, height: 900 } });
    }
  }

  console.log('OK — sélecteur FR / EN sans rechargement');

} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
