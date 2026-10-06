import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { buildInfo, writeBuildInfo } from '../scripts/build-info.mjs';
import { publishRelease, canPrepareRelease, dispatchReleaseTests } from '../scripts/releases.mjs';

const sha = 'a'.repeat(40), other = 'b'.repeat(40);
const context = { eventName: 'push', ref: 'refs/heads/main', sha, repo: { owner: 'eliasprunaire', repo: 'ai-status' } };
const missing = () => { throw Object.assign(new Error('Not found'), { status: 404 }); };
const fixture = () => {
  const state = {
    pr: { number: 24, user: { login: 'github-actions[bot]' }, head: { ref: 'release-please--branches--main--components--ai-status', sha, repo: { full_name: 'eliasprunaire/ai-status' } }, base: { ref: 'main' }, labels: [{ name: 'autorelease: pending' }], merged_at: '2026-09-12T00:00:00Z', merge_commit_sha: sha, body: '## 0.1.2\n\nPremière version formelle : suivi des fournisseurs et interface bilingue.' },
    files: { 'package.json': { version: '0.1.2' }, 'package-lock.json': { version: '0.1.2', packages: { '': { version: '0.1.2' } } }, '.release-please-manifest.json': { '.': '0.1.2' } },
    main: sha, tag: null, release: null, latest: null, runs: [], writes: [], reads: [],
  };
  const github = { paginate: async (fn, args) => (await fn(args)).data, rest: {
    repos: {
      listPullRequestsAssociatedWithCommit: async () => ({ data: [state.pr] }),
      getContent: async ({ path, ref }) => { state.reads.push(ref); return { data: { type: 'file', encoding: 'base64', size: 100, content: Buffer.from(JSON.stringify(state.files[path])).toString('base64') } }; },
      getReleaseByTag: async () => state.release ? { data: state.release } : missing(),
      getLatestRelease: async () => state.latest ? { data: state.latest } : missing(),
      createRelease: async args => { state.writes.push(['release', args]); state.release = args; return { data: args }; },
    },
    git: {
      getRef: async ({ ref }) => ref === 'heads/main' ? { data: { object: { sha: state.main } } } : state.tag ? { data: state.tag } : missing(),
      createRef: async args => { state.writes.push(['tag', args]); state.tag = { object: { type: 'commit', sha: args.sha } }; },
    },
    issues: {
      addLabels: async () => { state.writes.push(['label']); state.pr.labels.push({ name: 'autorelease: tagged' }); },
      removeLabel: async () => { state.writes.push(['unlabel']); state.pr.labels = state.pr.labels.filter(l => l.name !== 'autorelease: pending'); },
    },
    pulls: { list: async () => ({ data: [state.pr] }) },
    actions: {
      listWorkflowRuns: async () => ({ data: { workflow_runs: state.runs } }),
      createWorkflowDispatch: async args => { state.writes.push(['dispatch', args]); },
    },
  } };
  return { state, github, context, testsPassed: true };
};

const happy = fixture();
assert.deepEqual(await publishRelease(happy), { version: '0.1.2', sha, tag: 'v0.1.2' });
assert.ok(happy.state.reads.every(ref => ref === sha));
assert.equal(happy.state.release.target_commitish, sha);
assert.equal(happy.state.release.name, 'v0.1.2');
await publishRelease(happy);
assert.equal(happy.state.writes.filter(([kind]) => kind === 'tag').length, 1);
assert.equal(happy.state.writes.filter(([kind]) => kind === 'release').length, 1);

for (const mutate of [
  f => { f.testsPassed = false; },
  f => { f.state.files['package-lock.json'].packages[''].version = '0.1.1'; },
  f => { f.state.files['.release-please-manifest.json']['.'] = '0.1.3'; },
  f => { f.state.pr.body = ''; },
  f => { f.state.tag = { object: { type: 'commit', sha: other } }; },
  f => { f.state.tag = { object: { type: 'tag', sha } }; },
  f => { f.state.release = { target_commitish: other }; },
  f => { f.state.latest = { tag_name: 'v0.2.0' }; },
  f => { f.state.files['package-lock.json'].version = '0.1.1'; },
]) {
  const f = fixture(); mutate(f);
  await assert.rejects(publishRelease(f));
  assert.deepEqual(f.state.writes, [], 'échec avant toute mutation');
}
for (const mutate of [
  f => { f.context = { ...context, eventName: 'schedule' }; },
  f => { f.context = { ...context, eventName: 'workflow_dispatch' }; },
  f => { f.state.pr.merge_commit_sha = other; },
  f => { f.state.pr.user.login = 'someone-else'; },
  f => { f.state.pr.head.repo.full_name = 'someone-else/ai-status'; },
  f => { f.state.pr.merged_at = null; },
]) {
  const f = fixture(); mutate(f);
  assert.equal(await publishRelease(f), null);
  assert.deepEqual(f.state.writes, []);
}
const retry = fixture();
const create = retry.github.rest.repos.createRelease;
retry.github.rest.repos.createRelease = async () => { throw new Error('API indisponible'); };
await assert.rejects(publishRelease(retry));
assert.ok(retry.state.tag);
retry.github.rest.repos.createRelease = create;
await publishRelease(retry);
assert.equal(retry.state.writes.filter(([kind]) => kind === 'tag').length, 1);

const oldRun = fixture();
oldRun.state.main = other;
await publishRelease(oldRun);
assert.equal(oldRun.state.tag.object.sha, sha, 'un ancien run ne peut pas étiqueter la nouvelle tête de main');
const next = fixture();
next.state.latest = { tag_name: 'v0.1.2' };
next.state.files['package.json'].version = '0.1.3';
next.state.files['package-lock.json'].version = '0.1.3';
next.state.files['package-lock.json'].packages[''].version = '0.1.3';
next.state.files['.release-please-manifest.json']['.'] = '0.1.3';
next.state.pr.body = next.state.pr.body.replace('0.1.2', '0.1.3');
assert.equal((await publishRelease(next)).tag, 'v0.1.3');

const bot = fixture();
assert.equal(await canPrepareRelease(bot), true);
assert.equal(await dispatchReleaseTests(bot), sha);
assert.deepEqual(bot.state.writes[0][1].inputs, { expected_sha: sha });
assert.equal(bot.state.writes[0][1].workflow_id, 'tests.yml');
bot.state.runs = [{ head_sha: sha, status: 'completed', conclusion: 'success' }];
assert.equal(await dispatchReleaseTests(bot), null);

// Exécuter le garde réel du workflow avec une branche stable puis déplacée
const workflow = readFileSync(new URL('../.github/workflows/tests.yml', import.meta.url), 'utf8');
const publisher = readFileSync(new URL('../.github/workflows/collect.yml', import.meta.url), 'utf8').split('\n  publish:\n')[1].split('\n  release-pr:\n')[0];
assert.match(publisher, /pull-requests: write/, 'GitHub exige le droit PR en écriture pour marquer une PR publiée');
const collectWorkflow = readFileSync(new URL('../.github/workflows/collect.yml', import.meta.url), 'utf8');
assert.match(collectWorkflow, /  test:\n    uses: \.\/\.github\/workflows\/tests\.yml\n(?:    #[^\n]*\n)*    with:\n      expected_sha: \$\{\{ github\.sha \}\}\n/, 'la collecte passe son SHA au garde de tests.yml : un workflow_dispatch de collect.yml ne doit pas être refusé');
assert.match(collectWorkflow, /\nconcurrency:\n  group: collect-\$\{\{ github\.ref \}\}-\$\{\{ github\.event_name == 'push' && github\.sha \|\| 'periodic' \}\}\n  cancel-in-progress: \$\{\{ github\.event_name != 'push' \}\}\n/, 'un push a son groupe de concurrence par commit et n’est jamais annulé ; une collecte périodique bloquée est annulée par la suivante : run de publication des releases protégé');
assert.match(collectWorkflow, /  deploy:[\s\S]*?    concurrency:\n      group: pages\n      cancel-in-progress: false\n/, 'les déploiements Pages sont sérialisés sans interrompre celui en cours');
const jobBlock = (name) => collectWorkflow.split(`\n  ${name}:\n`)[1].split(/\n  [a-z-]+:\n/)[0];
assert.match(jobBlock('alert'), /issues: write/, 'le job alert gère les issues de surveillance');
assert.doesNotMatch(jobBlock('collect'), /issues: write/, 'la collecte, qui lit des pages tierces, n’écrit jamais d’issue');
const guard = workflow.match(/        run: \|\n([\s\S]*?)\n      - uses:/)[1].replace(/^          /gm, '');
for (const [event, expected, actual, status] of [
  ['workflow_dispatch', sha, sha, 0],
  ['workflow_dispatch', sha, other, 1],
  ['workflow_dispatch', '', sha, 1],
  ['pull_request', '', sha, 0],
]) {
  assert.equal(spawnSync('bash', ['-c', guard], { env: { ...process.env, GITHUB_EVENT_NAME: event, EXPECTED_SHA: expected, GITHUB_SHA: actual } }).status, status);
}
bot.state.pr.head.sha = other;
assert.equal(await dispatchReleaseTests(bot), other, 'un nouveau SHA demande ses propres tests');
bot.state.main = other;
assert.equal(await canPrepareRelease(bot), false);
assert.equal(await dispatchReleaseTests(bot), null);

const pkgBefore = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const info = writeBuildInfo();
assert.equal(info.version, JSON.parse(pkgBefore).version);
assert.deepEqual(info, buildInfo(info.version, info.sha));
assert.equal(readFileSync(new URL('../package.json', import.meta.url), 'utf8'), pkgBefore);
assert.throws(() => buildInfo('01.2.3', sha));
assert.throws(() => buildInfo('0.1.2', 'main'));
console.log('OK — publication liée au SHA testé, reprise idempotente, tests du robot et métadonnée de version');
