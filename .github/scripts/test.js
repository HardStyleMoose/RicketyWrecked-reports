'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { run, parseReport, signature, compareVersions, isTestReport } = require('./reports');
const conflicts = require('./conflicts');

const NOW = new Date('2026-10-28T06:17:00Z');
const RELAY = 'https://ljp-reports.ricketywrecked.workers.dev';
const WEBHOOK = 'https://discord.com/api/webhooks/123/fake';
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const clone = value => structuredClone(value);
const bot = { login: 'github-actions[bot]', type: 'Bot' };
const tag = (kind, key) => '<!-- ljp-bot:' + kind + ':' + key + ' -->';
const defaultError = '[23:06:00.001] [Error  : Unity Log] NullReferenceException: value 42\n  at Foo.Bar ()';

function report(options = {}) {
  const {
    version = '1.2.0', description = 'It broke', errors = defaultError,
    role = 'menu', players = '0', language = 'en-US', category = 'other',
    fence = '\x60\x60\x60',
  } = options;
  return [
    '| Field | Value |', '| --- | --- |',
    '| Mod | LateJoinPlus ' + version + ' |',
    '| Game | 0.4.4.3 |', '| Role | ' + role + ' |',
    '| Level | Level - Main Menu |', '| Players | ' + players + ' |',
    '| Language | ' + language + ' |', '| Category | ' + category + ' |',
    '| Report | 20261028-161430-818a5d |', '',
    '### Description', fence, description, fence, '',
    ...(errors === null ? [] : ['### Errors in this session', fence, errors, fence, '']),
    '### Mods (1)', fence,
    '- "LateJoinPlus" | "ricketywrecked.repo.latejoinplus" | "1.2.0"',
    fence, '', '[Full sanitized report](https://example.com/report.txt)',
  ].join('\n');
}

function issue(number, options = {}) {
  return {
    number, node_id: 'I_' + number, title: '[1.2.0] other: It broke',
    body: report(), labels: [], state: 'open', state_reason: null,
    created_at: new Date(Date.UTC(2026, 0, 1, 0, 0, number)).toISOString(),
    closed_at: null, locked: false, user: { login: 'HardStyleMoose', type: 'User' },
    ...options,
  };
}

const sig = signature(parseReport(report()));
const has = (item, label) => item.labels.some(value =>
  (typeof value === 'string' ? value : value.name) === label);

function fake(initial = [], latest = '1.2.0') {
  const issues = new Map(initial.map(item => [item.number, clone(item)]));
  const comments = new Map();
  const labels = new Map();
  for (const item of initial) for (const label of item.labels) {
    const name = typeof label === 'string' ? label : label.name;
    labels.set(name, { name, color: 'ffffff' });
  }
  const calls = [];
  const warnings = [];
  const infos = [];
  const state = {
    latest, fetchMode: 'ok', pinFails: false, failClose: 0, raceLabel: null,
    fetchCount: 0, failAdd: null, failLock: 0,
    now: new Date(NOW), relayCalls: [], gameReplies: [], relayGet: 'ok', relayPost: 'ok',
    rules: { mods: [] }, env: {}, logs: new Map(), discordCalls: [], discordMode: 200,
    packages: {}, packageCalls: [],
  };
  function failure(status) { return Object.assign(new Error('Fake failure'), { status }); }
  function record(name, params) { calls.push({ name, ...clone(params) }); }
  const api = {};
  for (const name of ['listForRepo', 'listComments']) {
    api[name] = async params => {
      record(name, params);
      let data;
      if (name === 'listComments') {
        data = comments.get(params.issue_number) || [];
      } else {
        data = [...issues.values()].filter(item =>
          (params.state === 'all' || item.state === params.state) &&
          (!params.labels || params.labels.split(',').every(label => has(item, label))));
        data.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.number - b.number);
        if (params.direction !== 'asc') data.reverse();
      }
      const start = ((params.page || 1) - 1) * params.per_page;
      return { data: clone(data.slice(start, start + params.per_page)) };
    };
  }
  for (const name of ['get', 'getLabel', 'createLabel', 'addLabels', 'removeLabel',
    'createComment', 'create', 'update', 'lock']) {
    api[name] = async params => {
      record(name, params);
      const item = issues.get(params.issue_number);
      let data;
      if (name === 'lock') {
        assert(!Object.hasOwn(params, 'lock_reason'));
        assert(!has(item, 'dashboard'));
        if (state.failLock > 0) { state.failLock--; throw failure(503); }
        item.locked = true;
        data = {};
      }
      if (name === 'get') data = item;
      if (name === 'getLabel') {
        if (!labels.has(params.name)) throw failure(404);
        data = labels.get(params.name);
      }
      if (name === 'createLabel') {
        if (state.raceLabel === params.name) {
          labels.set(params.name, clone(params));
          state.raceLabel = null;
          throw failure(422);
        }
        if (labels.has(params.name)) throw failure(422);
        labels.set(params.name, clone(params));
        data = params;
      }
      if (name === 'addLabels') {
        if (params.labels.includes(state.failAdd)) {
          state.failAdd = null;
          throw failure(503);
        }
        for (const name of params.labels) {
          assert(labels.has(name), 'Label must exist before use');
          if (!has(item, name)) item.labels.push({ name });
        }
        data = item.labels;
      }
      if (name === 'removeLabel') {
        item.labels = item.labels.filter(label =>
          (typeof label === 'string' ? label : label.name) !== params.name);
        data = item.labels;
      }
      if (name === 'createComment') {
        data = { id: calls.length, body: params.body, user: bot };
        if (!comments.has(item.number)) comments.set(item.number, []);
        comments.get(item.number).push(data);
      }
      if (name === 'create') {
        const number = Math.max(0, ...issues.keys()) + 1;
        data = issue(number, params);
        issues.set(number, data);
      }
      if (name === 'update') {
        if (params.state === 'closed' && state.failClose > 0) {
          state.failClose--;
          throw failure(503);
        }
        for (const key of ['title', 'body', 'state', 'state_reason']) {
          if (Object.hasOwn(params, key)) item[key] = params[key];
        }
        if (params.state === 'closed') item.closed_at = state.now.toISOString();
        if (params.state === 'open') {
          item.closed_at = null;
          item.state_reason = null;
        }
        data = item;
      }
      return { data: clone(data) };
    };
  }
  const github = {
    rest: { issues: api, repos: {
      async getContent(params) {
        record('getContent', params);
        if (!state.logs.has(params.path)) throw failure(404);
        return { data: { content: Buffer.from(state.logs.get(params.path)).toString('base64') } };
      },
    } },
    async paginate(method, params, mapper) {
      record('paginate', params);
      const result = [];
      for (let page = 1; ; page++) {
        const response = await method({ ...params, page });
        let done = false;
        result.push(...(mapper ? mapper(response, () => { done = true; }) : response.data));
        if (done || response.data.length < params.per_page) break;
      }
      return result;
    },
    async graphql(query, variables) {
      record('graphql', { query, variables });
      assert(query.includes('pinIssue'));
      if (state.pinFails) throw failure(403);
      return { pinIssue: { issue: { id: variables.id } } };
    },
  };
  const env = {
    issues, labels, comments, calls, warnings, infos, state, github,
    count(number, kind) {
      return (comments.get(number) || []).filter(comment =>
        comment.user.login === bot.login &&
        comment.body.includes('<!-- ljp-bot:' + kind + ':')).length;
    },
    dashboard() {
      return [...issues.values()].find(item =>
        item.title === 'Report dashboard' && has(item, 'dashboard'));
    },
    async fire(action = 'opened', number = 1, label, eventName = 'issues') {
      return run({
        github, now: state.now, rules: state.rules, env: state.env,
        context: {
          repo: { owner: 'HardStyleMoose', repo: 'RicketyWrecked-reports' },
          eventName,
          payload: { action, issue: clone(issues.get(number)), label: { name: label } },
        },
        core: { warning: message => warnings.push(message), info: message => infos.push(message) },
        fetch: async (url, options) => {
          if (url.startsWith(WEBHOOK)) {
            state.discordCalls.push({ url, ...options });
            assert(options.signal instanceof AbortSignal);
            assert.deepEqual(JSON.parse(options.body).allowed_mentions, { parse: [] });
            if (state.discordMode === 'network') throw new Error('Network failure');
            const status = state.discordMode === 404 && options.method === 'POST' ? 200 :
              (typeof state.discordMode === 'number' ? state.discordMode : 200);
            return { ok: status >= 200 && status < 300, status,
              json: async () => {
                if (state.discordMode === 'json') throw new Error('Bad JSON');
                return { id: String(100 + state.discordCalls.length) };
              } };
          }
          if (url === RELAY + '/bot') {
            assert.equal(options.method, 'POST');
            assert.equal(options.redirect, 'manual');
            assert.equal(options.headers.Authorization, 'Bearer ' + state.env.BOT_REPLY_SECRET);
            state.gameReplies.push(JSON.parse(options.body));
            return {ok: true, status: 200};
          }
          if (url.startsWith(RELAY)) {
            assert([RELAY + '/', RELAY + '/report'].includes(url));
            state.relayCalls.push({ url, options });
            assert(options.signal instanceof AbortSignal);
            assert.equal(options.redirect, 'error');
            assert.equal(options.headers.Accept, 'application/json');
            const post = url.endsWith('/report');
            assert.equal(options.method, post ? 'POST' : 'GET');
            const mode = post ? state.relayPost : state.relayGet;
            if (mode === 'timeout') {
              throw Object.assign(new Error('SECRET'), { name: 'TimeoutError' });
            }
            if (mode === 'network') throw new Error('SECRET @person');
            const status = typeof mode === 'number' ? mode : 200;
            return {
              ok: status >= 200 && status < 300, status,
              json: async () => {
                if (mode === 'json' || status === 429) throw new Error('SECRET');
                if (mode === 'body-timeout') {
                  throw Object.assign(new Error('SECRET'), { name: 'AbortError' });
                }
                if (mode === 'invalid') return { ok: 'true', reason: 'SECRET @person' };
                if (mode === 'service') return { ok: true, service: 'wrong', open: true };
                if (mode === 'dry-run') return { ok: true, dryRun: false };
                return post ? { ok: true, dryRun: true } :
                  { ok: true, service: 'ljp-reports', open: mode !== 'closed' };
              },
            };
          }
          const packageMatch = url.match(/^https:\/\/thunderstore\.io\/api\/experimental\/package\/([\w.-]+\/[\w.-]+)\/$/);
          if (packageMatch && packageMatch[1] !== 'RicketyWrecked/LateJoinPlus') {
            const name = packageMatch[1];
            state.packageCalls.push({ name, url, options });
            assert(options.signal instanceof AbortSignal);
            assert.equal(options.headers.Accept, 'application/json');
            const version = state.packages[name];
            if (version === 'throw') throw new Error('Network failure');
            return { ok: version !== 'http', json: async () => {
              if (version === 'json') throw new Error('Bad JSON');
              return { latest: { version_number: version } };
            } };
          }
          state.fetchCount++;
          assert.equal(url, 'https://thunderstore.io/api/experimental/package/RicketyWrecked/LateJoinPlus/');
          assert(options.signal);
          if (state.fetchMode === 'throw') throw new Error('Network failure');
          return {
            ok: state.fetchMode !== 'http',
            json: async () => {
              if (state.fetchMode === 'json') throw new Error('Bad JSON');
              return { latest: { version_number: state.latest } };
            },
          };
        },
      });
    },
  };
  return env;
}

function commentText(env, number) {
  return (env.comments.get(number) || []).map(comment => comment.body).join('\n');
}

function section(env, title) {
  return env.dashboard().body.split('**' + title + '**\n\n')[1].split('\n\n**')[0];
}

const conflictRule = (guid = 'example.broken') => ({
  guid, name: 'Broken Mod', brokenUpTo: '1.0', evidence: ['BrokenMod\\.Crash'],
  problem: 'Crashes.', fix: 'Remove it.', kind: 'broken',
});
const modLine = (name, guid, version = '1.0') => '- "' + name + '" | "' + guid + '" | "' + version + '"';
const reportPath = 'reports/2026/11/20261116-165238-3d36b3.txt';
function storedReport(env, log, number = 1) {
  env.issues.get(number).body = report().replace('https://example.com/report.txt',
    'https://github.com/HardStyleMoose/RicketyWrecked-reports/blob/main/' + reportPath);
  env.state.logs.set(reportPath, log);
}
const discordPosts = env => env.state.discordCalls.filter(call => call.method === 'POST');
const cosmetics = '[Error : Unity Log] PlayerCosmetics: No colors equipped after 10 seconds, equipping default colors.';

test('loadRules validates package paths and fixed entries', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(require('node:os').tmpdir(), 'rw-updates-' + require('node:crypto').randomUUID() + '.json');
  const write = data => fs.writeFileSync(file, JSON.stringify(data));
  try {
    for (const value of ['', 'Team', 'Team/Name/extra', '../Team/Name', 'Team/Bad Name', null, 12]) {
      write({ mods: [{ ...conflictRule(), package: value }] });
      assert.throws(() => conflicts.loadRules(file), /Invalid Thunderstore package/);
    }
    write({ mods: [{ ...conflictRule(), package: 'Team_1/Name-2.3' }] });
    assert.equal(conflicts.loadRules(file).mods[0].package, 'Team_1/Name-2.3');
    for (const fixed of [{}, [null], [{}], [{ guid: 'x', name: 'X', fixedIn: 'bad', date: '2026-11-16' }]]) {
      write({ mods: [], fixed });
      assert.throws(() => conflicts.loadRules(file));
    }
    write({ mods: [], fixed: [{ guid: 'x', name: 'X', fixedIn: '1.2', date: '2026-11-16' }] });
    assert.equal(conflicts.loadRules(file).fixed.length, 1);
  } finally { fs.unlinkSync(file); }
});

test('updates are judged against packageVersion, not the plugin version in brokenUpTo', async () => {
  const env = fake([]);
  // Plugin reports 1.0.0 while its Thunderstore package is already 4.5.4: no update yet.
  env.state.rules = { mods: [{ ...conflictRule(), package: 'Team/Name', packageVersion: '4.5.4' }] };
  env.state.packages['Team/Name'] = '4.5.4';
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  await env.fire(null, null, null, 'schedule');
  const updates = () => discordPosts(env).map(call => JSON.parse(call.body).content)
    .filter(text => text.startsWith('**Update:**'));
  assert.equal(updates().length, 0);
  env.state.packages['Team/Name'] = '4.6.0';
  await env.fire(null, null, null, 'schedule');
  assert.equal(updates().length, 1);
});

test('package checks cache per package, show updates and announce each guid/version only once', async () => {
  const env = fake([]);
  env.state.rules = { mods: [conflictRule(), conflictRule('example.second')].map(rule =>
    ({ ...rule, package: 'Team/Name' })) };
  env.state.packages['Team/Name'] = '1.2.0';
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  const timeout = AbortSignal.timeout;
  const delays = [];
  AbortSignal.timeout = ms => { delays.push(ms); return timeout(ms); };
  try { await env.fire(null, null, null, 'schedule'); }
  finally { AbortSignal.timeout = timeout; }
  assert.equal(env.state.packageCalls.length, 1);
  assert.equal(delays.filter(ms => ms === 15000).length, 5); // LJ+, package, two updates, list
  assert.equal(env.state.fetchCount, 1);
  const updates = () => discordPosts(env).map(call => JSON.parse(call.body).content)
    .filter(text => text.startsWith('**Update:**'));
  assert.deepEqual(updates(), Array(2).fill('**Update:** Broken Mod 1.2.0 is out; new reports will show if it works now.'));
  assert.equal(JSON.parse(env.state.discordCalls.at(-1).body).content.match(/ - update 1\.2\.0 out, may be fixed/g).length, 2);
  await env.fire(null, null, null, 'workflow_dispatch');
  assert.equal(env.state.packageCalls.length, 2);
  assert.equal(updates().length, 2);
  await env.fire('closed', env.dashboard().number);
  assert.equal(env.state.packageCalls.length, 2); // issue events preserve update-out without probing
  assert(JSON.parse(env.state.discordCalls.at(-1).body).content.includes(' - update 1.2.0 out, may be fixed'));
  env.state.packages['Team/Name'] = '1.10.0';
  await env.fire(null, null, null, 'schedule');
  assert.equal(updates().length, 4);
  env.state.packages['Team/Name'] = '1.2.0';
  await env.fire(null, null, null, 'schedule');
  assert.equal(updates().length, 4); // remember all pairs, even after a rollback
});

test('package failures warn once per package and never fail the run', async () => {
  for (const mode of ['throw', 'http', 'json', 'invalid', undefined]) {
    const env = fake([]);
    env.state.rules = { mods: [conflictRule(), conflictRule('example.second')].map(rule =>
      ({ ...rule, package: 'Team/Bad' })) };
    env.state.packages['Team/Bad'] = mode;
    await env.fire(null, null, null, 'schedule');
    assert(env.dashboard());
    assert.equal(env.warnings.length, 1);
    assert(env.warnings[0].includes('Team/Bad'));
    assert.equal(env.state.packageCalls.length, 1);
    assert.equal(env.state.fetchCount, 1);
  }
});

test('only scheduled runs fetch packages and only capped newer releases count as updates', async () => {
  const env = fake([]);
  env.state.rules = { mods: [
    { ...conflictRule(), package: 'Team/Equal' },
    { ...conflictRule('other.guid'), package: 'Team/Uncapped', brokenUpTo: undefined },
  ] };
  env.state.packages = { 'Team/Equal': '1.0.0', 'Team/Uncapped': '99.0' };
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  await env.fire('closed', null);
  assert.equal(env.state.packageCalls.length, 0);
  await env.fire(null, null, null, 'schedule');
  assert.equal(env.state.packageCalls.length, 2);
  assert(!env.state.discordCalls.some(call => JSON.parse(call.body).content.includes('**Update:**')));
  assert(!JSON.parse(env.state.discordCalls.at(-1).body).content.includes('may be fixed'));
});

test('fixed mods leave matching and the list and announce Works again once', async () => {
  const env = fake([]);
  const rule = conflictRule();
  env.state.rules = { mods: [rule] };
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  await env.fire(null, null, null, 'schedule');
  env.state.rules.fixed = [{ guid: rule.guid.toUpperCase(), name: rule.name, fixedIn: '1.2.0', date: '2026-11-16' }];
  assert.equal(conflicts.detect('BrokenMod.Crash', [{ guid: rule.guid, version: '1.0' }], env.state.rules).known.length, 0);
  assert(!conflicts.listMessage(env.state.rules, new Map()).includes('Broken Mod'));
  await env.fire(null, null, null, 'workflow_dispatch');
  await env.fire('closed', env.dashboard().number);
  const notes = discordPosts(env).map(call => JSON.parse(call.body).content)
    .filter(text => text.startsWith('**Works again:**'));
  assert.deepEqual(notes, ['**Works again:** Broken Mod 1.2.0. Removed from the list.']);
  assert(!section(env, 'Possibly fixed').includes('Broken Mod'));
  assert(!JSON.parse(env.state.discordCalls.at(-1).body).content.includes('Broken Mod'));
});

test('disabled or failing Discord announcements retry after recovery without losing history', async () => {
  const env = fake([]);
  env.state.rules = { mods: [{ ...conflictRule(), package: 'Team/Name' }],
    fixed: [{ guid: 'fixed.guid', name: 'Fixed Mod', fixedIn: '2.0', date: '2026-11-16' }] };
  env.state.packages['Team/Name'] = '1.2.0';
  await env.fire(null, null, null, 'schedule');
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  env.state.discordMode = 503;
  await env.fire(null, null, null, 'schedule');
  env.state.discordMode = 200;
  await env.fire(null, null, null, 'schedule');
  const posts = discordPosts(env).length;
  env.state.env = {};
  await env.fire('closed', env.dashboard().number);
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  await env.fire(null, null, null, 'schedule');
  assert.equal(discordPosts(env).length, posts);
});

test('new reports label possible fixes, aggregate versions and retain closed report evidence', async () => {
  const env = fake([issue(1), issue(2)]);
  env.state.rules = { mods: [conflictRule()] };
  storedReport(env, modLine('Broken Mod', 'example.broken', '1.2.0'));
  await env.fire();
  assert(has(env.issues.get(1), 'mod-fixed:example.broken'));
  assert.equal(env.issues.get(1).state, 'open');
  assert(section(env, 'Possibly fixed').includes('| Broken Mod | 1.2.0 | #1 |'));
  // Use the issue body for the second report so the two stored logs stay independent.
  env.issues.get(2).body += '\n' + modLine('Broken Mod', 'example.broken', '1.10.0');
  await env.fire('opened', 2);
  await env.fire(null, null, null, 'schedule');
  assert(section(env, 'Possibly fixed').includes('| Broken Mod | 1.2.0, 1.10.0 |'));
  assert(section(env, 'Possibly fixed').includes('#1'));
  assert(section(env, 'Possibly fixed').includes('#2'));
  assert.equal(env.issues.get(2).state, 'closed'); // duplicate still counts as evidence
});

test('possible fixes require a numeric newer version and no rule evidence, and never recheck old reports', async () => {
  for (const [version, log, action, locked] of [
    ['1.0', '', 'opened', false], ['unknown', '', 'opened', false],
    ['1.2.0', 'BrokenMod.Crash', 'opened', false],
    ['1.2.0', '', 'closed', false], ['1.2.0', '', 'schedule', true],
  ]) {
    const env = fake([issue(1, { locked })]);
    env.state.rules = { mods: [conflictRule()] };
    storedReport(env, modLine('Broken Mod', 'example.broken', version) + '\n' + log);
    if (action === 'schedule') await env.fire(null, null, null, 'schedule');
    else await env.fire(action, 1);
    assert(!has(env.issues.get(1), 'mod-fixed:example.broken'));
    assert(!section(env, 'Possibly fixed').includes('Broken Mod'));
  }
});

test('possible-fix labels shorten long GUIDs without collisions or counting as broken mods', async () => {
  const guid = 'example.' + 'a'.repeat(70);
  assert.equal(conflicts.labelFor(guid, 'mod-fixed:').length, 50);
  assert.notEqual(conflicts.labelFor(guid + 'one', 'mod-fixed:'), conflicts.labelFor(guid + 'two', 'mod-fixed:'));
  const env = fake([issue(1)]);
  env.state.rules = { mods: [conflictRule(guid)] };
  storedReport(env, modLine('Broken Mod', guid, '1.2.0'));
  await env.fire();
  assert(has(env.issues.get(1), conflicts.labelFor(guid, 'mod-fixed:')));
  assert(section(env, 'Possibly fixed').includes('| Broken Mod | 1.2.0 | #1 |'));
  assert(env.dashboard().body.includes('| Broken Mod | <= 1.0 | Crashes. | Remove it. | 0 |'));
});

test('unavailable full logs cannot establish that broken evidence is absent', async () => {
  const env = fake([issue(1)]);
  env.state.rules = { mods: [conflictRule()] };
  storedReport(env, '');
  env.state.logs.clear();
  env.issues.get(1).body += '\n' + modLine('Broken Mod', 'example.broken', '1.2.0');
  await env.fire();
  assert(!has(env.issues.get(1), 'mod-fixed:example.broken'));
});

test('loadRules validates harmless lists, fields and regular expressions', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const file = path.join(require('node:os').tmpdir(), 'rw-harmless-' + require('node:crypto').randomUUID() + '.json');
  try {
    for (const harmless of [{}, [null], [{}], [{ pattern: 3, why: 'reason' }],
      [{ pattern: 'x', why: ' ' }], [{ pattern: '[', why: 'reason' }]]) {
      fs.writeFileSync(file, JSON.stringify({ mods: [], harmless }));
      assert.throws(() => conflicts.loadRules(file));
    }
    fs.writeFileSync(file, JSON.stringify({ mods: [], harmless: [{ pattern: 'message', why: 'reason' }] }));
    assert(conflicts.loadRules(file).harmless[0].harmlessRegex.test('MESSAGE'));
  } finally {
    fs.unlinkSync(file);
  }
});

test('harmlessOnly matches every configured message with variable IDs and deduplicates reasons', () => {
  const rules = conflicts.loadRules();
  const lines = [cosmetics,
    'Failed to find a PhotonView with ID=98765 for incoming OwnershipUpdate event',
    'Received RPC "SomeMethod" for viewID 456 but this PhotonView does not exist',
    "RPC method 'OtherMethod' not found on object with PhotonView 789",
    '[Recorder] Voice: MicWrapper: Microphone is no longer recording',
    'Connection lost. OnStatusChanged to TimeoutDisconnect', 'network disconnect report:',
    'Screen position out of view frustum', 'ValuablePropSwitch: No ValuableVolume found',
    "Can't remove PhotonView (Script) because EnemyParent (Script) depends on it",
    '[NoSaveDelete] Save folder not found',
    '[Fatal  :com.github.zehsteam.ExtractionPointConfirmButton] ExtractionPointPatch: Failed to spawn confirm button. GameObject is null.'];
  for (let i = 0; i < lines.length; i++) {
    assert.deepEqual(conflicts.harmlessOnly([lines[i].toUpperCase()], rules), [rules.harmless[i].why]);
  }
  assert.deepEqual(conflicts.harmlessOnly([...lines, cosmetics], rules), rules.harmless.map(rule => rule.why));
});

test('harmlessOnly rejects one real error and empty or frame-only error sections', () => {
  const rules = conflicts.loadRules();
  assert.equal(conflicts.harmlessOnly([cosmetics, 'NullReferenceException: real failure'], rules), null);
  for (const errors of [[], undefined, [' ', 'at Foo.Bar ()']]) {
    assert.equal(conflicts.harmlessOnly(errors, rules), null);
  }
});

test('harmlessOnly ignores blank lines, stack frames and repetition counts', () => {
  const rules = conflicts.loadRules();
  assert.deepEqual(conflicts.harmlessOnly([cosmetics, '', '  ', '  at Game.Method ()',
    'UnityEngine.Debug.Log ()', 'System.Reflection.Invoke ()', 'HarmonyLib.Patch ()',
    'Rethrow as Exception', '(wrapper managed-to-native) Foo ()', '(seen 345 times)'], rules),
  [rules.harmless[0].why]);
});

test('opened cosmetics report closes harmless once before matching an old closed signature', async () => {
  const body = report({ errors: cosmetics });
  const env = fake([issue(43, { body, state: 'closed', labels: [signature(parseReport(body))] }),
    issue(84, { body })]);
  env.state.rules = conflicts.loadRules();
  await env.fire('opened', 84);
  await env.fire('opened', 84);
  const item = env.issues.get(84);
  assert(has(item, 'harmless'));
  assert.equal(env.labels.get('harmless').color, 'c2e0c6');
  assert.equal(item.state, 'closed');
  assert.equal(item.state_reason, 'not_planned');
  assert.equal(env.count(84, 'harmless'), 1);
  assert.equal(env.comments.get(84).length, 1);
  assert(!commentText(env, 84).includes('Looks like'));
  assert(!item.labels.some(label => /^sig-/.test(label.name || label)));
  assert(commentText(env, 84).includes('- ' + env.state.rules.harmless[0].why));
  assert(env.dashboard().body.includes('Harmless game-message reports closed in the last 14 days: 1'));
});

test('harmless closure retries after failure and schedule handles locked reports without mod lists', async () => {
  const env = fake([issue(1, { locked: true, body: report({ errors: cosmetics }).split('### Mods')[0] })]);
  env.state.rules = conflicts.loadRules();
  env.state.failClose = 1;
  await assert.rejects(env.fire(null, null, null, 'schedule'));
  await env.fire(null, null, null, 'schedule');
  assert.equal(env.issues.get(1).state_reason, 'not_planned');
  assert.equal(env.count(1, 'harmless'), 1);
});

test('harmless lines with our own errors in the section or stored log stay open', async () => {
  for (const inLog of [false, true]) {
    const own = '[Error :LateJoinPlus] NullReferenceException in Foo';
    const env = fake([issue(1, { body: report({ errors: cosmetics + (inLog ? '' : '\n' + own) }) })]);
    env.state.rules = conflicts.loadRules();
    if (inLog) {
      storedReport(env, own);
      env.issues.get(1).body = env.issues.get(1).body.replace(defaultError, cosmetics);
    }
    await env.fire();
    assert.equal(env.issues.get(1).state, 'open');
    assert(!has(env.issues.get(1), 'harmless'));
  }
});

test('suspects take precedence over harmless error lines', async () => {
  const env = fake([issue(1)]);
  env.state.rules = conflicts.loadRules();
  storedReport(env, modLine('Unknown Mod', 'example.unknown') + '\n[Error :Unknown Mod] Failed');
  env.issues.get(1).body = env.issues.get(1).body.replace(defaultError, cosmetics);
  await env.fire();
  await env.fire(null, null, null, 'schedule');
  assert(has(env.issues.get(1), 'suspect-mod'));
  assert.equal(env.issues.get(1).state, 'open');
  assert(!has(env.issues.get(1), 'harmless'));
});

test('dashboard harmless count includes only closures within the last 14 days', async () => {
  const at = offset => new Date(NOW.getTime() + offset).toISOString();
  const env = fake([
    issue(1, { labels: ['harmless'], state: 'closed', closed_at: at(-14 * 86400000) }),
    issue(2, { labels: ['harmless'], state: 'closed', closed_at: at(0) }),
    issue(3, { labels: ['harmless'], state: 'closed', closed_at: at(-14 * 86400000 - 1) }),
    issue(4, { labels: ['harmless'], state: 'closed', closed_at: at(1) }),
    issue(5, { labels: ['harmless'], state: 'open', closed_at: at(-1000) }),
    issue(6, { labels: ['harmless'], state: 'closed', closed_at: 'invalid' }),
    issue(7, { state: 'closed', closed_at: at(-1000) }),
  ]);
  await env.fire('closed', 1);
  assert(env.dashboard().body.includes('Harmless game-message reports closed in the last 14 days: 2'));
  assert(section(env, 'Open problems').includes('#5'));
});

test('parseMods reads sample list, CRLF, trims fields and deduplicates GUIDs', () => {
  assert.deepEqual(conflicts.parseMods('Mods (3):\r\n' +
    modLine(' Broken Mod ', 'example.broken', '1.0') + '\r\n' +
    modLine('duplicate', 'EXAMPLE.BROKEN') + '\r\n' + modLine('LateJoinPlus', 'ricketywrecked.repo.latejoinplus')), [
    { name: 'Broken Mod', guid: 'example.broken', version: '1.0' },
    { name: 'LateJoinPlus', guid: 'ricketywrecked.repo.latejoinplus', version: '1.0' },
  ]);
});

test('detect requires matching GUID, version and evidence, or version alone for empty evidence', () => {
  const rule = conflictRule();
  const mods = conflicts.parseMods(modLine('Broken Mod', rule.guid));
  assert.equal(conflicts.detect('BrokenMod.Crash', mods, { mods: [rule] }).known.length, 1);
  assert.equal(conflicts.detect('BrokenModXCrash', mods, { mods: [rule] }).known.length, 0);
  assert.equal(conflicts.detect('BrokenMod.Crash', [{ ...mods[0], guid: 'other.mod' }], { mods: [rule] }).known.length, 0);
  assert.equal(conflicts.detect('BrokenMod.Crash', [{ ...mods[0], version: '1.0.1' }], { mods: [rule] }).known.length, 0);
  assert.equal(conflicts.detect('', mods, { mods: [{ ...rule, evidence: [] }] }).known.length, 1);
  assert.equal(conflicts.detect('BrokenMod.Crash', [{ ...mods[0], version: 'unknown' }], { mods: [rule] }).known.length, 0);
});

test('evidence recognizes Who-patches postfix and a mod error source', () => {
  const mods = conflicts.parseMods(modLine('Wall Climb', 'example.wallclimb') + '\n' +
    modLine('Empress Spawn Browser', 'Empress.SpawnBrowser'));
  const found = conflicts.evidence("Who patches the methods in this log's errors:\n" +
    '  PlayerController.Update: example.wallclimb (postfix)\n\n' +
    '[Error :Empress Spawn Browser] Failed', mods);
  assert.deepEqual(found.map(s => s.mod.guid), ['example.wallclimb', 'Empress.SpawnBrowser']);
  assert.match(found[0].why[0], /postfix/);
});

test('evidence skips system frames with and without at, then finds PetCompanion', () => {
  const mods = conflicts.parseMods(modLine('Pet Companion', 'com.yanyan.repo.petcompanion'));
  for (const prefix of ['', 'at ']) {
    const found = conflicts.evidence('Stack trace:\n  ' + prefix + 'UnityEngine.Debug.Log ()\n  ' +
      prefix + 'PetCompanion.PetFollower.LateUpdate ()', mods);
    assert.equal(found.length, 1);
    assert.equal(found[0].mod.guid, mods[0].guid);
  }
  const unityMod = conflicts.parseMods(modLine('UnityTools', 'example.unitytools'));
  assert.equal(conflicts.evidence('Stack trace:\nUnityTools.Plugin.Update ()', unityMod).length, 1);
});

test('libraries and our own mods never become suspects through any evidence source', () => {
  const mods = conflicts.parseMods([
    modLine('REPOLib', 'REPOLib'), modLine('MenuLib', 'nickklmao.menulib'),
    modLine('MenuLib', 'MenuLib'), modLine('LateJoinPlus', 'ricketywrecked.repo.latejoinplus'),
    modLine('Lobby Guard', 'ricketywrecked.repo.lobbyguard'),
  ].join('\n'));
  for (const mod of mods) {
    const log = "Who patches the methods in this log's errors:\n  Game.Update: " + mod.guid +
      ' (postfix)\n\n[Error :' + mod.name + '] Failed\nStack trace:\n  ' + mod.name.replace(/ /g, '') + '.Plugin.Update ()';
    assert.deepEqual(conflicts.evidence(log, mods), []);
  }
});

test('long GUID labels stay within 50 characters and do not merge shared prefixes', () => {
  const prefix = 'example.' + 'a'.repeat(60);
  assert.equal(conflicts.labelFor(prefix).length, 50);
  assert.notEqual(conflicts.labelFor(prefix + 'one'), conflicts.labelFor(prefix + 'two'));
  assert.equal(conflicts.labelFor('Example.Short'), 'mod:example.short');
});

test('opened known conflict labels, comments and closes once, with optional Discord', async () => {
  for (const enabled of [false, true]) {
    const env = fake([issue(1)]);
    env.state.rules = { mods: [conflictRule()] };
    if (enabled) env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
    storedReport(env, modLine('Broken Mod', 'example.broken') + '\nBrokenMod.Crash');
    await env.fire();
    await env.fire();
    const item = env.issues.get(1);
    assert(has(item, 'mod:example.broken'));
    assert(has(item, 'other-mod'));
    assert(!has(item, sig));
    assert.equal(item.state, 'closed');
    assert.equal(item.state_reason, 'not_planned');
    assert.equal(env.count(1, 'other-mod'), 1);
    assert.equal(env.calls.filter(call => call.name === 'update' && call.issue_number === 1 && call.state === 'closed').length, 1);
    assert.equal(discordPosts(env).length, enabled ? 2 : 0); // New conflict and the list.
    assert(discordPosts(env).every(call => call.url === WEBHOOK + '?wait=true'));
    if (enabled) assert.equal(discordPosts(env).filter(call => JSON.parse(call.body).content.startsWith('**New:**')).length, 1);
    assert(env.calls.some(call => call.name === 'getContent' && call.path === reportPath));
  }
});

test('a known mod next to our own error is labelled and commented but stays open', async () => {
  assert(!conflicts.ownErrors('[Error  :LateJoinPlus] First error this session: x\n[Error  :R.E.P.O Fixes+] [Extra slots keep items] could not apply Y'));
  assert(conflicts.ownErrors('[Error  :LateJoinPlus] NullReferenceException in Foo'));
  const env = fake([issue(1)]);
  env.state.rules = { mods: [conflictRule()] };
  storedReport(env, modLine('Broken Mod', 'example.broken') + '\nBrokenMod.Crash\n[Error  :LateJoinPlus] NullReferenceException in Foo');
  await env.fire();
  const item = env.issues.get(1);
  assert(has(item, 'mod:example.broken'));
  assert(has(item, 'other-mod'));
  assert.equal(item.state, 'open');
  assert.equal(env.count(1, 'other-mod'), 1);
});

test('multiple known mods keep comma-separated markers idempotent after failed close', async () => {
  const env = fake([issue(1)]);
  env.state.rules = { mods: [conflictRule(), conflictRule('example.second')] };
  storedReport(env, modLine('Broken Mod', 'example.broken') + '\n' + modLine('Second', 'example.second') + '\nBrokenMod.Crash');
  env.state.failClose = 1;
  await assert.rejects(env.fire(), /Fake failure/);
  await env.fire();
  await env.fire();
  assert.equal(env.count(1, 'other-mod'), 1);
  assert(commentText(env, 1).includes(tag('other-mod', 'example.broken,example.second')));
  assert.equal(env.issues.get(1).state_reason, 'not_planned');
});

test('suspects work without known rules, stay open and continue signature logic', async () => {
  const env = fake([issue(1)]);
  storedReport(env, modLine('Empress Spawn Browser', 'Empress.SpawnBrowser') + '\n[Error :Empress Spawn Browser] Failed');
  await env.fire();
  await env.fire();
  await env.fire(null, null, null, 'schedule');
  assert(has(env.issues.get(1), 'suspect-mod'));
  assert(has(env.issues.get(1), 'mod:empress.spawnbrowser'));
  assert(has(env.issues.get(1), sig));
  assert.equal(env.count(1, 'suspect-mod'), 1);
  assert.equal(env.issues.get(1).state, 'open');
});

test('closed issues never get suspect labels or comments from a delayed opened event', async () => {
  const env = fake([issue(1, { state: 'closed', state_reason: 'completed' })]);
  storedReport(env, modLine('Empress Spawn Browser', 'Empress.SpawnBrowser') + '\n[Error :Empress Spawn Browser] Failed');
  await env.fire();
  assert(!has(env.issues.get(1), 'suspect-mod'));
  assert.equal(env.count(1, 'suspect-mod'), 0);
  assert.equal(env.issues.get(1).state_reason, 'completed');
});

test('schedule applies grown rules to locked reports and avoids double close', async () => {
  const env = fake([issue(1, { locked: true, labels: ['fixed-in:1.2.0'] }), issue(2)]);
  env.state.rules = { mods: [conflictRule()] };
  for (const number of [1, 2]) storedReport(env, modLine('Broken Mod', 'example.broken') + '\nBrokenMod.Crash', number);
  await env.fire(null, null, null, 'schedule');
  await env.fire(null, null, null, 'schedule');
  for (const number of [1, 2]) {
    assert.equal(env.count(number, 'other-mod'), 1);
    assert.equal(env.count(number, 'released'), 0);
    assert.equal(env.issues.get(number).state_reason, 'not_planned');
    assert.equal(env.calls.filter(call => call.name === 'update' && call.issue_number === number && call.state === 'closed').length, 1);
  }
});

test('first known announcement counts closed conflicts but ignores earlier suspects', async () => {
  for (const previous of ['other-mod', 'suspect-mod']) {
    const env = fake([issue(1, { labels: ['mod:example.broken', previous], state: 'closed' }), issue(2)]);
    env.state.rules = { mods: [conflictRule()] };
    env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
    storedReport(env, modLine('Broken Mod', 'example.broken') + '\nBrokenMod.Crash', 2);
    await env.fire('opened', 2);
    const announcements = discordPosts(env).filter(call => JSON.parse(call.body).content.startsWith('**New:**'));
    assert.equal(announcements.length, previous === 'other-mod' ? 0 : 1);
    assert(env.calls.some(call => call.name === 'listForRepo' && call.labels === 'mod:example.broken' && call.state === 'all'));
  }
});

test('promoting an existing suspect to known still sends the first announcement', async () => {
  const env = fake([issue(1, { labels: ['mod:example.broken', 'mod:example.other', 'suspect-mod'], locked: true })]);
  env.state.rules = { mods: [conflictRule()] };
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  storedReport(env, modLine('Broken Mod', 'example.broken') + '\nBrokenMod.Crash');
  await env.fire(null, null, null, 'schedule');
  assert(!has(env.issues.get(1), 'suspect-mod'));
  assert(!has(env.issues.get(1), 'mod:example.other')); // a stale suspect label goes
  assert(has(env.issues.get(1), 'mod:example.broken'));
  assert.equal(discordPosts(env).filter(call => JSON.parse(call.body).content.startsWith('**New:**')).length, 1);
});

test('dashboard has both mod tables and preserves Discord id through unchanged edits and 404', async () => {
  const env = fake([issue(1, { labels: ['other-mod', 'mod:example.broken'], state: 'closed' }),
    issue(2, { labels: ['suspect-mod', 'mod:example.suspect'], locked: true })]);
  env.state.rules = { mods: [conflictRule()] };
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  await env.fire('closed', 1);
  assert.match(env.dashboard().body, /\*\*Mods that break the game\*\*/);
  assert.match(env.dashboard().body, /\| Mod \| Versions \| Problem \| Fix \| Reports \|/);
  assert.match(env.dashboard().body, /\*\*Suspected mods\*\*/);
  assert.match(env.dashboard().body, /\| example.suspect \| 1 \| #2 \|/);
  const hidden = env.dashboard().body.match(/<!-- ljp-bot:discord-list:(\d+):([a-f0-9]+) -->/);
  assert(hidden);
  await env.fire('closed', 1);
  assert.equal(discordPosts(env).length, 1);
  assert.equal(env.state.discordCalls.at(-1).method, 'PATCH');
  assert.equal(env.state.discordCalls.at(-1).url, WEBHOOK + '/messages/' + hidden[1]);
  assert(env.dashboard().body.endsWith(hidden[0]));
  env.state.discordMode = 404;
  await env.fire('closed', 1);
  assert.equal(discordPosts(env).length, 2);
  assert(!env.dashboard().body.endsWith(hidden[0]));
  const replacement = env.dashboard().body.match(/<!-- ljp-bot:discord-list:.* -->/)[0];
  env.state.env = {};
  await env.fire('closed', 1);
  assert(env.dashboard().body.endsWith(replacement));
});

test('dashboard counts known mods whose GUIDs need shortened labels', async () => {
  const guid = 'example.' + 'a'.repeat(60);
  const env = fake([issue(1, { labels: ['other-mod', conflicts.labelFor(guid)], state: 'closed' })]);
  env.state.rules = { mods: [conflictRule(guid)] };
  env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
  await env.fire('closed', 1);
  assert.match(env.dashboard().body, /\| Broken Mod \| <= 1.0 \| Crashes\. \| Remove it\. \| 1 \|/);
  assert(JSON.parse(discordPosts(env)[0].body).content.includes('(1 report)'));
});

test('Discord failures never fail triage and preserve the last list marker for retry', async () => {
  for (const mode of [503, 'network', 'json']) {
    const env = fake([issue(1)]);
    env.state.rules = { mods: [conflictRule()] };
    env.state.env.DISCORD_CONFLICTS_WEBHOOK = WEBHOOK;
    await env.fire('closed', 1);
    const hidden = env.dashboard().body.match(/<!-- ljp-bot:discord-list:.* -->/)[0];
    env.state.discordMode = mode;
    storedReport(env, modLine('Broken Mod', 'example.broken') + '\nBrokenMod.Crash');
    await env.fire();
    assert.equal(env.issues.get(1).state_reason, 'not_planned');
    assert(env.warnings.some(warning => warning.startsWith('Discord:')));
    if (mode !== 'json') {
      assert(env.warnings.some(warning => warning.startsWith('Discord list:')));
      assert(env.dashboard().body.endsWith(hidden));
    }
  }
});

test('parse complete relay report and CRLF', () => {
  assert.deepEqual(parseReport(report().replace(/\n/g, '\r\n')), {
    version: '1.2.0', game: '0.4.4.3', role: 'menu', level: 'Level - Main Menu',
    players: '0', language: 'en-US', category: 'other',
    reportId: '20261028-161430-818a5d', description: 'It broke',
    errors: defaultError.split('\n').map(line => line.trim()),
  });
  assert.equal(parseReport('A hand-made issue'), null);
  assert.equal(parseReport('### Description\n\x60\x60\x60\n| Report | forged |\n\x60\x60\x60'), null);
});

test('variable fences preserve embedded fences and headings', () => {
  const description = 'hello\n\x60\x60\x60\n### Errors in this session\n| Report | fake |\nworld';
  const result = parseReport(report({ description, fence: '\x60\x60\x60\x60\x60' }));
  assert.equal(result.description, description);
  assert.equal(result.reportId, '20261028-161430-818a5d');
  assert.deepEqual(result.errors, defaultError.split('\n').map(line => line.trim()));
});

test('missing and explicitly empty error sections have no signature', () => {
  for (const errors of [null, '', 'None.', 'There were none.', 'No errors in this session.']) {
    assert.deepEqual(parseReport(report({ errors })).errors, []);
    assert.equal(signature(parseReport(report({ errors }))), null);
  }
});

test('signature normalizes timestamps, source padding, numbers, hex, GUIDs and frames', () => {
  const a = parseReport(report({ errors:
    '[01:02:03.456] [Error  : Unity Log] Failed 12 0xAFF abcdef12 01234567-89ab-cdef-0123-456789abcdef\n' +
    ' at Foo.Call<System.Int32> () [0x0012]\n at Different.Second ()' }));
  const b = parseReport(report({ version: '9.8.0', errors:
    '[23:59:59.000] [Error:Unity Log] Failed 99 0x123 deadbeef fedcba98-7654-3210-fedc-ba9876543210\n' +
    'at Foo.Call<List<String>> () [0xFF]\nat Other.Second ()' }));
  b.level = 'Different level';
  const expected = 'sig-' + createHash('sha1')
    .update('Unity Log Failed N X X X\nat Foo.Call ()').digest('hex').slice(0, 7);
  assert.equal(signature(a), expected);
  assert.equal(signature(b), expected);
  assert.notEqual(signature({ errors: ['Other error', 'at Foo.Call ()'] }), expected);
  assert.notEqual(signature({ errors: [a.errors[0], 'at Different.First ()'] }), expected);
  assert.match(signature({ errors: ['Error without frame'] }), /^sig-[0-9a-f]{7}$/);
});

test('numeric dotted versions and strict test classification', () => {
  assert.equal(compareVersions('1.10.0', '1.9.3'), 1);
  assert.equal(compareVersions('1.2', '1.2.0.0'), 0);
  assert.equal(compareVersions('01.2', '1.2'), 0);
  assert.equal(compareVersions('1.2.0', '1.2.1'), -1);
  assert.throws(() => compareVersions('oops', '1.0'), TypeError);
  for (const description of [' TEST ', 'Testing', 'Setup test from CLI']) {
    assert(isTestReport({ description }));
  }
  for (const description of ['', 'test crash', 'a setup test', 'testing now']) {
    assert(!isTestReport({ description }));
  }
});

test('manual and removal requests remain open and comments are idempotent', async () => {
  const env = fake([issue(1, { body: 'Help', title: 'Hand-made issue' }),
    issue(2, { body: 'Please remove', title: 'Remove report 123' })]);
  await env.fire('opened', 1);
  await env.fire('opened', 2);
  await env.fire('opened', 2);
  assert(has(env.issues.get(1), 'manual'));
  assert.equal(env.count(1, 'removal'), 0);
  assert(has(env.issues.get(2), 'removal-request'));
  assert.equal(env.count(2, 'removal'), 1);
  assert(commentText(env, 2).includes('Thanks — the owner will remove it.'));
  assert.equal(env.issues.get(1).state, 'open');
  assert.equal(env.issues.get(2).state, 'open');
  assert(!section(env, 'Open problems').includes('#1'));
  assert(!section(env, 'Open problems').includes('#2'));
});

test('test reports close completed without signature or old-version labels', async () => {
  const env = fake([issue(1, { body: report({ description: ' SETUP TEST local', version: '0.1' }) })]);
  await env.fire();
  await env.fire();
  const item = env.issues.get(1);
  assert(has(item, 'test'));
  assert(!has(item, sig));
  assert(!has(item, 'old-version'));
  assert.equal(item.state_reason, 'completed');
  assert.equal(env.count(1, 'test'), 1);
  assert(commentText(env, 1).startsWith('Test report received — closing it.'));
  assert(!section(env, 'Open problems').includes('#1'));
});

test('signature label creation, old-version advice and open duplicate routing', async () => {
  const env = fake([issue(1), issue(2, { body: report({ version: '1.1.0' }) })]);
  env.state.raceLabel = sig;
  await env.fire('opened', 1);
  assert.equal(env.labels.get(sig).color, 'ededed');
  assert.equal(env.labels.get(sig).description, 'Same error');
  await env.fire('opened', 2);
  await env.fire('opened', 2);
  assert.equal(env.issues.get(2).state_reason, 'not_planned');
  assert(has(env.issues.get(2), 'duplicate'));
  assert(has(env.issues.get(2), 'old-version'));
  assert.equal(env.count(1, 'seen'), 1);
  assert.equal(env.count(2, 'duplicate'), 1);
  assert.equal(env.count(2, 'old-version'), 1);
  assert(commentText(env, 1).includes('Seen again in #2 (v1.1.0, menu, 0 players, en-US).'));
  assert(commentText(env, 2).includes('Same problem as #1 — following it there. Thanks!'));
  assert(commentText(env, 2).includes('This was sent from LateJoinPlus 1.1.0, and 1.2.0 is out.'));
  assert(section(env, 'Open problems').includes('| #1 | 2 | 1.1.0, 1.2.0 |'));
});

test('duplicates select oldest eligible original across multiple pages', async () => {
  const data = [issue(1, { labels: [sig, 'test'] }),
    issue(2, { labels: [sig, 'dashboard'] }), issue(3, { labels: [sig] })];
  for (let i = 4; i <= 110; i++) data.push(issue(i, { labels: [sig] }));
  const env = fake(data);
  await env.fire('opened', 110);
  assert(commentText(env, 110).includes('Same problem as #3'));
  assert(env.calls.some(call => call.name === 'listForRepo' && call.page === 2));
  assert(env.calls.filter(call => call.name === 'paginate' && !call.issue_number)
    .every(call => call.state === 'all' && call.per_page === 100));
});

test('no signature means no duplicate, even with identical descriptions', async () => {
  const env = fake([issue(1, { body: report({ errors: null }) }),
    issue(2, { body: report({ errors: null }) })]);
  await env.fire('opened', 1);
  await env.fire('opened', 2);
  assert.equal(env.issues.get(1).state, 'open');
  assert.equal(env.issues.get(2).state, 'open');
  assert(!has(env.issues.get(2), 'duplicate'));
  assert(section(env, 'Open problems').includes('| #1 | 1 |'));
  assert(section(env, 'Open problems').includes('| #2 | 1 |'));
});

test('older than a released fix closes fixed-already, completed', async () => {
  const env = fake([issue(1, { labels: [sig, 'fixed-in:1.3.0'], state: 'closed' }),
    issue(2)]);
  await env.fire('opened', 2);
  await env.fire('opened', 2);
  assert(has(env.issues.get(2), 'fixed-already'));
  assert(!has(env.issues.get(2), 'duplicate'));
  assert.equal(env.issues.get(2).state_reason, 'completed');
  assert.equal(env.count(2, 'fixed-already'), 1);
  assert(commentText(env, 2).includes('This is fixed in LateJoinPlus 1.3.0. Please update in r2modman.'));
});

test('equal or newer report reopens a fixed original and survives the next schedule', async () => {
  for (const version of ['1.2.0', '1.3.0']) {
    const env = fake([issue(1, { labels: [sig, 'fixed-in:1.2.0'], state: 'closed' }),
      issue(2, { body: report({ version }) })], '1.3.0');
    await env.fire('opened', 2);
    await env.fire('opened', 2);
    await env.fire(null, null, null, 'schedule');
    assert.equal(env.issues.get(1).state, 'open');
    assert(has(env.issues.get(1), 'regression'));
    assert(!has(env.issues.get(1), 'fixed-in:1.2.0'));
    assert.equal(env.count(1, 'regression'), 1);
    assert.equal(env.count(1, 'seen'), 0);
    assert.equal(env.issues.get(2).state_reason, 'not_planned');
    assert(commentText(env, 1).includes(
      'It happened again in v' + version + ' (#2), after the fix in 1.2.0.'));
  }
});

test('closed original without a fix only gets a related link', async () => {
  const env = fake([issue(1, { labels: [sig], state: 'closed' }), issue(2)]);
  await env.fire('opened', 2);
  await env.fire('opened', 2);
  assert.equal(env.issues.get(2).state, 'open');
  assert.equal(env.count(2, 'related'), 1);
  assert(commentText(env, 2).includes('Looks like #1.'));
  assert(!has(env.issues.get(2), 'duplicate'));
});

test('retry after failed duplicate close does not repeat comments', async () => {
  const env = fake([issue(1, { labels: [sig] }), issue(2)]);
  env.state.failClose = 1;
  await assert.rejects(env.fire('opened', 2));
  assert(env.dashboard());
  await env.fire('opened', 2);
  assert.equal(env.count(1, 'seen'), 1);
  assert.equal(env.count(2, 'duplicate'), 1);
  assert.equal(env.issues.get(2).state_reason, 'not_planned');
});

test('retry after partial regression resumes the recorded operation', async () => {
  const env = fake([issue(1, { labels: [sig, 'fixed-in:1.2.0'], state: 'closed' }), issue(2)]);
  env.state.failAdd = 'regression';
  await assert.rejects(env.fire('opened', 2));
  await env.fire('opened', 2);
  assert.equal(env.issues.get(1).state, 'open');
  assert.equal(env.count(1, 'regression'), 1);
  assert.equal(env.count(2, 'duplicate'), 1);
});

test('untrusted comment markers cannot suppress bot comments', async () => {
  const env = fake([issue(1, { body: 'remove', title: 'Remove report 123' })]);
  env.comments.set(1, [{ body: tag('removal', 1), user: { login: 'HardStyleMoose', type: 'User' } }]);
  await env.fire();
  assert.equal(env.count(1, 'removal'), 1);
});

test('fixed-in label announces once, waits, then dispatch closes and removes regression', async () => {
  const env = fake([issue(1, { labels: ['fixed-in:1.10.0', 'regression'] })], '1.9.3');
  await env.fire('labeled', 1, 'fixed-in:1.10.0');
  await env.fire('labeled', 1, 'fixed-in:1.10.0');
  assert.equal(env.issues.get(1).state, 'open');
  assert.equal(env.count(1, 'fix-ready'), 1);
  assert(commentText(env, 1).includes('A fix is ready and will be in LateJoinPlus 1.10.0.'));
  assert(section(env, 'Fix waiting for release').includes('| #1 | 1.10.0 |'));
  env.state.latest = '1.10.0';
  await env.fire(null, null, null, 'workflow_dispatch');
  await env.fire(null, null, null, 'workflow_dispatch');
  assert.equal(env.count(1, 'released'), 1);
  assert.equal(env.issues.get(1).state_reason, 'completed');
  assert(!has(env.issues.get(1), 'regression'));
  assert(commentText(env, 1).includes(
    'Fixed in LateJoinPlus 1.10.0 — update in r2modman. If it still happens, send a new report from the game.'));
  assert(section(env, 'Fixed in the last 14 days').includes('| #1 | 1.10.0 |'));
});

test('dispatch posts a fix-ready note a replaced labeled run missed, once', async () => {
  const env = fake([issue(1, { labels: ['fixed-in:1.10.0'] }), issue(2, { labels: ['fixed-in:1.10.0'] })], '1.9.3');
  await env.fire('labeled', 1, 'fixed-in:1.10.0');
  await env.fire(null, null, null, 'workflow_dispatch');
  await env.fire(null, null, null, 'schedule');
  assert.equal(env.count(1, 'fix-ready'), 1);
  assert.equal(env.count(2, 'fix-ready'), 1);
  assert.equal(env.issues.get(2).state, 'open');
});

test('already released fixed-in closes immediately; retry repairs failed close', async () => {
  const env = fake([issue(1, { labels: ['fixed-in:1.2.0'] })], '1.3.0');
  env.state.failClose = 1;
  await assert.rejects(env.fire('labeled', 1, 'fixed-in:1.2.0'));
  await env.fire('labeled', 1, 'fixed-in:1.2.0');
  assert.equal(env.count(1, 'fix-ready'), 1);
  assert.equal(env.count(1, 'released'), 1);
  assert.equal(env.issues.get(1).state_reason, 'completed');
});

test('schedule checks all open fixes and uses the highest of multiple fix labels', async () => {
  const env = fake([
    issue(1, { labels: ['fixed-in:1.1.0', 'fixed-in:1.3.0'] }),
    issue(2, { labels: ['fixed-in:1.2.0'] }),
    issue(3, { labels: ['fixed-in:1.1.0'], state: 'closed' }),
  ]);
  await env.fire(null, null, null, 'schedule');
  assert.equal(env.issues.get(1).state, 'open');
  assert.equal(env.issues.get(2).state_reason, 'completed');
  assert.equal(env.count(3, 'released'), 0);
  assert.equal(env.state.fetchCount, 1);
});

test('malformed or removed fixed-in labels do not trigger release checks', async () => {
  const env = fake([issue(1, { labels: ['fixed-in:1.2.0'] })]);
  for (const name of ['fixed-in:1', 'fixed-in:1.2.3.4.5', 'fixed-in:1.2-beta',
    'fixed-in:1.2.0\n', 'fixed-in:9.9', 'other']) {
    await env.fire('labeled', 1, name);
  }
  assert.equal(env.count(1, 'fix-ready'), 0);
  assert.equal(env.count(1, 'released'), 0);
});

test('reopened and closed only refresh the dashboard, even for released fixes', async () => {
  const env = fake([issue(1, { labels: ['fixed-in:1.2.0'] })]);
  await env.fire('reopened');
  await env.fire('closed');
  assert.equal(env.issues.get(1).state, 'open');
  assert.equal(env.count(1, 'released'), 0);
  assert.equal(env.count(1, 'fix-ready'), 0);
  assert(env.dashboard());
});

test('fetch failures warn once per run, preserve open fixes and still refresh dashboard', async () => {
  for (const mode of ['throw', 'http', 'json', 'invalid']) {
    const env = fake([issue(1, { labels: ['fixed-in:1.0'] })]);
    env.state.fetchMode = mode;
    if (mode === 'invalid') env.state.latest = 'not-a-version';
    await env.fire(null, null, null, 'schedule');
    assert.equal(env.issues.get(1).state, 'open');
    assert.equal(env.warnings.length, 1);
    assert.equal(env.state.fetchCount, 1);
    assert(env.dashboard().body.includes('Thunderstore: unavailable.'));
  }
});

test('fetch failure does not prevent duplicate routing', async () => {
  const env = fake([issue(1, { labels: [sig] }), issue(2)]);
  env.state.fetchMode = 'throw';
  await env.fire('opened', 2);
  assert.equal(env.issues.get(2).state_reason, 'not_planned');
  assert(!has(env.issues.get(2), 'old-version'));
});

test('comments paginate: a bot marker past page one still prevents a repost', async () => {
  const env = fake([issue(1, { title: 'Remove report 123', body: 'remove' })]);
  env.comments.set(1, Array.from({ length: 101 }, (_, index) => ({
    id: index, body: index === 100 ? tag('removal', 1) : 'Earlier comment',
    user: index === 100 ? bot : { login: 'person', type: 'User' },
  })));
  await env.fire();
  assert.equal(env.count(1, 'removal'), 1);
  assert(!env.calls.some(call => call.name === 'createComment'));
});

test('comments keep untrusted metadata short and never echo the description', async () => {
  const long = '@somebody ' + 'secret '.repeat(1000);
  const env = fake([issue(1, { labels: [sig] }), issue(2, {
    body: report({ description: long, role: long, language: '@person', players: '$(bad)' }),
  })]);
  await env.fire('opened', 2);
  const text = commentText(env, 1) + commentText(env, 2);
  assert(!text.includes('@'));
  assert(!text.includes('secret'));
  assert(text.includes('unknown'));
  for (const call of env.calls.filter(call => call.name === 'createComment')) {
    assert(call.body.length < 400);
  }
});

test('fixed-in labels can be created on demand when missing from the repository lookup', async () => {
  const env = fake([issue(1, { labels: ['fixed-in:2.0'] })]);
  env.labels.delete('fixed-in:2.0');
  await env.fire('labeled', 1, 'fixed-in:2.0');
  assert.equal(env.labels.get('fixed-in:2.0').color, '0e8a16');
});

test('dashboard groups only linked duplicates; versions and last-seen use reports', async () => {
  const env = fake([
    issue(1, { labels: [sig], body: report({ version: '1.9.0' }) }),
    issue(2, { labels: [sig, 'duplicate'], state: 'closed', body: report({ version: '1.10.0' }) }),
    issue(3, { labels: [sig, 'duplicate'], state: 'closed', body: report({ version: '1.9.0' }) }),
    issue(4, { labels: [sig], state: 'closed', body: report({ version: '8.0' }) }),
    issue(5, { labels: [sig, 'duplicate'], state: 'closed', body: report({ version: '9.0' }) }),
    issue(6, { labels: [sig, 'test'] }),
    issue(7, { labels: ['manual'] }),
    issue(8, { labels: ['removal-request'] }),
    issue(9, { body: report({ errors: null }) }),
    issue(10, { body: report({ errors: null }) }),
  ]);
  env.comments.set(2, [{ body: tag('duplicate', 1), user: bot }]);
  env.comments.set(3, [{ body: tag('duplicate', 1), user: bot }]);
  env.comments.set(5, [{ body: tag('duplicate', 99), user: bot }]);
  await env.fire('closed', 1);
  const open = section(env, 'Open problems');
  assert(open.includes('| #1 | 3 | 1.9.0, 1.10.0 | 2026-01-01 | other |'));
  assert(!open.includes('8.0'));
  assert(!open.includes('9.0 |'));
  assert(open.indexOf('| #1 |') < open.indexOf('| #10 |'));
  assert(open.indexOf('| #10 |') < open.indexOf('| #9 |'));
  for (const number of [6, 7, 8]) assert(!open.includes('| #' + number + ' |'));
});

test('needs-info requires an open relay, empty description and no errors', async () => {
  const env = fake([
    issue(1, { body: report({ errors: null, description: ' ' }) }),
    issue(2, { body: report({ description: '' }) }),
    issue(3, { body: report({ errors: null, description: ' ' }), state: 'closed' }),
    issue(4, { body: '' }),
  ]);
  await env.fire('closed', 1);
  assert(has(env.issues.get(1), 'needs-info'));
  for (const number of [2, 3, 4]) assert(!has(env.issues.get(number), 'needs-info'));
  assert(section(env, 'Needs info').includes('| #1 |'));
  assert.equal(env.labels.get('needs-info').color, 'd4c5f9');
});

test('dashboard shows waiting fixes and only fixes closed within 14 days', async () => {
  const daysAgo = n => new Date(NOW.getTime() - n * 86400000).toISOString();
  const env = fake([
    issue(1, { labels: ['fixed-in:9.0'] }),
    issue(2, { labels: ['fixed-in:1.0'], state: 'closed', closed_at: daysAgo(13) }),
    issue(3, { labels: ['fixed-in:1.0'], state: 'closed', closed_at: daysAgo(15) }),
    issue(4, { state: 'closed', closed_at: daysAgo(1) }),
    issue(5, { labels: ['test', 'fixed-in:1.0'], state: 'closed', closed_at: daysAgo(1) }),
  ]);
  await env.fire('closed', 1);
  assert(section(env, 'Fix waiting for release').includes('| #1 | 9.0 |'));
  const recent = section(env, 'Fixed in the last 14 days');
  assert(recent.includes('| #2 | 1.0 |'));
  for (const number of [3, 4, 5]) assert(!recent.includes('| #' + number + ' |'));
});

test('dashboard is created once, rewrites its body, ignores pin failures and skips opened triage', async () => {
  const env = fake([]);
  env.state.pinFails = true;
  await env.fire(null, null, null, 'workflow_dispatch');
  const dash = env.dashboard();
  dash.body = 'stale';
  await env.fire('opened', dash.number);
  assert.equal(env.calls.filter(call => call.name === 'create').length, 1);
  assert.equal(env.calls.filter(call => call.name === 'createComment').length, 0);
  assert(!has(dash, 'manual'));
  assert(dash.body.startsWith('Updated '));
  assert(dash.body.includes('Latest LateJoinPlus on Thunderstore: 1.2.0.'));
  assert.equal(env.labels.get('dashboard').color, '5319e7');
  assert.equal(env.infos.length, 2);
});

test('dashboard safely renders hostile titles and category fields', async () => {
  const env = fake([issue(1, {
    title: '<img src=x> @person | [click](bad)\nsecond line ' + 'x'.repeat(500),
    body: report({ errors: null, category: '@person <script>' }),
  })]);
  await env.fire('closed', 1);
  const body = env.dashboard().body;
  assert(!body.includes('<img'));
  assert(!body.includes('<script>'));
  assert(!body.includes('@person'));
  assert(!body.includes('second line'));
  assert(body.includes('&#124;'));
  assert(body.includes('&lt;img'));
});

test('dashboard caps open rows at 50 and excludes pull requests', async () => {
  const items = Array.from({ length: 60 }, (_, index) =>
    issue(index + 1, { body: report({ errors: null }) }));
  items.push(issue(61, { pull_request: { url: 'https://example.com/pr' } }));
  const env = fake(items);
  await env.fire('closed', 1);
  const open = section(env, 'Open problems');
  assert.equal((open.match(/^\| #/gm) || []).length, 50);
  assert(!open.includes('| #61 |'));
  assert(open.includes('| #60 |'));
});

test('pagination stops at 1000 and finds an older existing dashboard separately', async () => {
  const items = Array.from({ length: 1050 }, (_, index) =>
    issue(index + 1, { body: report({ errors: null }) }));
  items[0] = issue(1, { title: 'Report dashboard', labels: ['dashboard'] });
  const env = fake(items);
  await env.fire('closed', 1050);
  assert.equal(env.dashboard().number, 1);
  assert(!env.calls.some(call => call.name === 'create'));
  const scans = env.calls.filter(call => call.name === 'listForRepo' && !call.labels);
  assert.equal(Math.max(...scans.map(call => call.page)), 10);
  assert(env.dashboard().body.includes('limited to 1,000'));
  assert(!section(env, 'Open problems').includes('| #2 |'));
});

test('both description headings parse safely, including the relay no-error placeholder', () => {
  for (const heading of ['Description', "Player's description"]) {
    const body = report({ description: 'test', errors: 'No matching error lines.' })
      .replace('### Description', '### ' + heading);
    const parsed = parseReport(body);
    assert.equal(parsed.description, 'test');
    assert.equal(signature(parsed), null);
    assert(isTestReport(parsed));
  }
});

test('every relay triage path locks once with no reason, after triage', async () => {
  const cases = [
    [issue(1)],
    [issue(1, { body: report({ description: 'test' }) })],
    [issue(1, { body: report({ version: '1.0' }) })],
    [issue(1, { body: report({ errors: null }) })],
    [issue(1, { labels: [sig] }), issue(2)],
    [issue(1, { labels: [sig, 'fixed-in:9.0'], state: 'closed' }), issue(2)],
    [issue(1, { labels: [sig], state: 'closed' }), issue(2)],
  ];
  for (const items of cases) {
    const env = fake(items);
    const number = items.at(-1).number;
    await env.fire('opened', number);
    await env.fire('opened', number);
    assert.equal(env.issues.get(number).locked, true);
    const locks = env.calls.filter(call => call.name === 'lock');
    assert.equal(locks.length, 1);
    assert.equal(locks[0].issue_number, number);
    const lockIndex = env.calls.indexOf(locks[0]);
    assert(env.calls.slice(lockIndex + 1).every(call =>
      call.name !== 'createComment' || call.issue_number !== number));
    assert.equal(env.dashboard().locked, false);
  }
  const locked = fake([issue(1, { locked: true })]);
  await locked.fire();
  assert(!locked.calls.some(call => call.name === 'lock'));
});

test('non-owner issues close and lock, even copied relay bodies and removal requests', async () => {
  for (const body of ['Hand-made message', report()]) {
    const env = fake([issue(1, { body, title: 'Remove report SECRET',
      user: { login: 'attacker', type: 'User' } })]);
    await env.fire();
    await env.fire();
    await env.fire('reopened');
    const item = env.issues.get(1);
    assert.equal(item.state_reason, 'not_planned');
    assert.equal(item.locked, true);
    assert(has(item, 'manual'));
    assert(!has(item, 'removal-request'));
    assert.equal(env.count(1, 'game-only'), 1);
    assert.equal(commentText(env, 1),
      'Please send reports from the game (LateJoinPlus menu → Send a bug report).\n\n' + tag('game-only', 1));
    assert(!env.dashboard().body.includes('SECRET'));
    assert.equal(env.calls.filter(call => call.name === 'lock').length, 1);
  }
  const owner = fake([issue(1, { body: 'Hand-made' })]);
  await owner.fire();
  assert(has(owner.issues.get(1), 'manual'));
  assert.equal(owner.issues.get(1).state, 'open');
  assert.equal(owner.issues.get(1).locked, false);
});

test('locking and outsider closing recover from partial failures without repeated comments', async () => {
  const env = fake([issue(1, { body: 'Hand-made', user: { login: 'outsider' } })]);
  env.state.failClose = 1;
  await assert.rejects(env.fire());
  assert(env.issues.get(1).locked);
  await env.fire();
  assert.equal(env.count(1, 'game-only'), 1);
  assert.equal(env.issues.get(1).state_reason, 'not_planned');

  const relay = fake([issue(1, { body: report({ description: 'test' }) })]);
  relay.state.failLock = 1;
  await assert.rejects(relay.fire());
  assert(relay.dashboard());
  await relay.fire();
  assert(relay.issues.get(1).locked);
  assert.equal(relay.count(1, 'test'), 1);

  const failedTriage = fake([issue(1), issue(2)]);
  await failedTriage.fire('opened', 1);
  failedTriage.state.failClose = 1;
  await assert.rejects(failedTriage.fire('opened', 2));
  assert(failedTriage.issues.get(2).locked);
});

test('dashboard is never locked, even if it has a different author', async () => {
  const env = fake([issue(1, { title: 'Report dashboard', labels: ['dashboard'],
    user: bot })]);
  await env.fire();
  assert.equal(env.issues.get(1).state, 'open');
  assert(!env.calls.some(call => call.name === 'lock' || call.name === 'createComment'));
});

test('volume warning counts recently closed test or duplicate reports once, only above 20', async () => {
  const now = NOW.getTime();
  const at = ms => new Date(now + ms).toISOString();
  const entries = Array.from({ length: 20 }, (_, index) => issue(index + 1, {
    labels: [index % 2 ? 'test' : 'duplicate'], state: 'closed',
    closed_at: at(-3600000),
  }));
  entries.push(
    issue(21, { labels: ['test'], state: 'closed', closed_at: at(-86400001) }),
    issue(22, { labels: ['test'], state: 'open', closed_at: at(-1000) }),
    issue(23, { labels: ['test'], state: 'closed', closed_at: at(3600000) }),
    issue(24, { labels: ['test'], state: 'closed', closed_at: 'invalid' }),
    issue(25, { labels: ['test'], state: 'closed', closed_at: at(-1000), body: 'manual' }),
    issue(26, { labels: ['dashboard', 'test'], state: 'closed', closed_at: at(-1000) }),
    issue(27, { labels: ['manual', 'test'], state: 'closed', closed_at: at(-1000) }),
  );
  const env = fake(entries);
  await env.fire('closed', 1);
  assert(!env.dashboard().body.includes('Unusual volume'));
  env.issues.set(40, issue(40, { labels: ['test', 'duplicate'], state: 'closed',
    closed_at: at(-1000) }));
  await env.fire('closed', 1);
  assert(env.dashboard().body.startsWith('Unusual volume in the last 24 h: 21 reports.'));
});

test('dashboard displays the error title without rewriting it', async () => {
  const title = '[1.2.0] other: NullReferenceException: value 42';
  const env = fake([issue(1, { title })]);
  await env.fire();
  assert(section(env, 'Open problems').includes(
    '\\[1.2.0\\] other: NullReferenceException: value 42'));
  assert(section(env, 'Open problems').includes('| Title |'));
});

test('scheduled and dispatch health checks validate both endpoints and the dry-run body', async () => {
  for (const event of ['schedule', 'workflow_dispatch']) {
    const env = fake([]);
    const timeout = AbortSignal.timeout;
    const delays = [];
    AbortSignal.timeout = ms => { delays.push(ms); return timeout(ms); };
    try {
      await env.fire(null, null, null, event);
    } finally {
      AbortSignal.timeout = timeout;
    }
    assert.deepEqual(delays, [15000, 10000, 10000]);
    assert.equal(env.state.relayCalls.length, 2);
    const [get, post] = env.state.relayCalls;
    assert.equal(get.url, RELAY + '/');
    assert.equal(get.options.body, undefined);
    assert.equal(post.url, RELAY + '/report');
    assert.equal(post.options.headers['Content-Type'], 'application/json');
    const body = JSON.parse(post.options.body);
    assert.match(body.installId, /^[0-9a-f]{32}$/);
    assert.deepEqual(body, {
      v: 1, mod: 'LateJoinPlus', modVersion: '0.0', gameVersion: '0.0',
      installId: body.installId, category: 'other', description: 'health check',
      role: 'menu', level: '', players: 0, language: 'en-US', mods: [], log: '', test: true,
    });
    assert(env.dashboard().body.startsWith('Relay: OK (checked 2026-10-28T06:17:00Z)'));
    assert(env.dashboard().body.includes('<!-- relay:ok:2026-10-28T06:17:00Z -->'));
    await env.fire(null, null, null, event);
    assert.notEqual(JSON.parse(env.state.relayCalls[3].options.body).installId, body.installId);
    assert.equal(env.calls.filter(call => call.name === 'create').length, 1);
    assert.equal(env.calls.filter(call => call.name === 'createComment').length, 0);
  }
});

test('429 on dry run is healthy, but 429 on GET is a problem', async () => {
  const env = fake([]);
  env.state.relayPost = 429;
  await env.fire(null, null, null, 'schedule');
  assert(env.dashboard().body.startsWith('Relay: OK'));
  env.state.relayGet = 429;
  env.state.relayCalls = [];
  await env.fire(null, null, null, 'schedule');
  assert(env.dashboard().body.startsWith('**Relay problem:** HTTP 429'));
  assert.equal(env.state.relayCalls.length, 1);
});

test('health failures use fixed reasons and never expose response or exception text', async () => {
  for (const endpoint of ['relayGet', 'relayPost']) {
    const cases = [
      ['timeout', 'timeout'], ['body-timeout', 'timeout'], ['json', 'not JSON'],
      [503, 'HTTP 503'], ['network', 'network error'], ['invalid', 'invalid response'],
      ...(endpoint === 'relayGet' ? [['closed', 'closed'], ['service', 'invalid response']] :
        [['dry-run', 'invalid response']]),
    ];
    for (const [mode, reason] of cases) {
      const env = fake([]);
      env.state[endpoint] = mode;
      await env.fire(null, null, null, 'workflow_dispatch');
      const body = env.dashboard().body;
      assert(body.startsWith('**Relay problem:** ' + reason +
        ' (checked 2026-10-28T06:17:00Z). Reports from the game may be failing.'));
      assert(body.includes('<!-- relay:fail:2026-10-28T06:17:00Z:' + reason + ' -->'));
      assert(!body.includes('SECRET'));
      assert(!body.includes('@person'));
      assert.equal(env.state.relayCalls.length, endpoint === 'relayGet' ? 1 : 2);
    }
  }
});

test('issue events preserve both stored health results without probing the relay', async () => {
  for (const mode of ['ok', 'closed']) {
    const env = fake([]);
    env.state.relayGet = mode;
    await env.fire(null, null, null, 'schedule');
    const first = env.dashboard().body.split('\n\n').slice(0, 2);
    env.state.now = new Date('2026-10-29T12:00:00Z');
    env.state.relayCalls = [];
    for (const action of ['opened', 'closed', 'reopened', 'labeled']) {
      await env.fire(action, env.dashboard().number);
      assert.deepEqual(env.dashboard().body.split('\n\n').slice(0, 2), first);
    }
    assert.equal(env.state.relayCalls.length, 0);
  }
});

test('missing or hostile stored results are not echoed and do not cause an issue-event probe', async () => {
  for (const body of [
    '', '<!-- relay:fail:2026-10-28T06:17:00Z:SECRET @person -->',
    '<!-- relay:fail:2026-10-28T06:17:00Z:closed\nSECRET -->',
    '<!-- relay:ok:2026-02-30T06:17:00Z -->',
    '<!-- relay:ok:2026-10-28T06:17:00Z:closed -->',
    '<!-- relay:fail:2026-10-28T06:17:00Z -->',
  ]) {
    const env = fake([issue(1, { title: 'Report dashboard', labels: ['dashboard'], body })]);
    await env.fire('closed', 1);
    assert.equal(env.state.relayCalls.length, 0);
    assert(!env.dashboard().body.includes('relay:'));
    assert(!env.dashboard().body.includes('SECRET'));
  }
});

test('next scheduled check replaces a stored failure with a fresh healthy result', async () => {
  const env = fake([]);
  env.state.relayGet = 500;
  await env.fire(null, null, null, 'schedule');
  env.state.relayGet = 'ok';
  env.state.now = new Date('2026-10-29T06:17:00Z');
  await env.fire(null, null, null, 'schedule');
  assert(env.dashboard().body.startsWith('Relay: OK (checked 2026-10-29T06:17:00Z)'));
  assert(!env.dashboard().body.includes('relay:fail'));
  assert(!env.dashboard().body.includes('HTTP 500'));
});

test('reminders are hidden more than 30 UTC calendar days before their dates', async () => {
  const env = fake([]);
  for (const date of ['2026-10-28', '2027-03-28']) {
    env.state.now = new Date(date + 'T23:59:59Z');
    await env.fire('closed', null);
    assert(!env.dashboard().body.includes('**Reminders**'));
  }
  env.state.now = new Date('2027-09-27T23:59:59Z');
  await env.fire('closed', null);
  assert(!env.dashboard().body.includes("relay's GitHub token"));
});

test('reminders appear at exactly 30 days and on the due date, on every run type', async () => {
  for (const event of ['issues', 'schedule', 'workflow_dispatch']) {
    const env = fake([]);
    for (const date of ['2027-03-29', '2027-04-28']) {
      env.state.now = new Date(date + 'T00:00:00Z');
      await env.fire('closed', null, null, event);
      assert(env.dashboard().body.includes('**Reminders**'));
      assert(env.dashboard().body.includes(
        'Only-you limit on issues/comments ends 2027-04-28: renew it (see the check-reports notes).'));
      assert(!env.dashboard().body.includes("relay's GitHub token"));
    }
    for (const date of ['2027-09-28', '2027-10-28']) {
      env.state.now = new Date(date + 'T23:59:59Z');
      await env.fire('closed', null, null, event);
      assert(env.dashboard().body.includes(
        "The relay's GitHub token expires 2027-10-28: make a new one and run " +
        '`npx wrangler secret put GITHUB_TOKEN` in tools/bug-relay.'));
    }
  }
});

test('past renewal dates use bold ended and expired wording', async () => {
  const env = fake([]);
  env.state.now = new Date('2027-04-29T00:00:00Z');
  await env.fire('closed', null);
  assert(env.dashboard().body.includes('**Only-you limit on issues/comments ended 2027-04-28**'));
  env.state.now = new Date('2027-10-29T00:00:00Z');
  await env.fire('closed', null);
  assert(env.dashboard().body.includes('**Only-you limit on issues/comments ended 2027-04-28**'));
  assert(env.dashboard().body.includes("**The relay's GitHub token expired 2027-10-28**"));
});

test('enrolled duplicate receives a fix only after Thunderstore confirms release and the original remains fixed', async () => {
  const original = issue(1, {labels:[sig,'fixed-in:1.3.0'],state:'closed'});
  const enrolled = issue(2, {state:'closed', created_at:NOW.toISOString(),
    body:report().replace('20261028-161430-818a5d','mail-' + 'a'.repeat(32))});
  const env = fake([original,enrolled], '1.2.0');
  env.state.env.BOT_REPLY_SECRET = 'test-only-bot';
  env.comments.set(1,[{user:bot,body:tag('released','1.3.0')}]);
  env.comments.set(2,[{user:bot,body:tag('duplicate','1')}]);
  await env.fire('closed',2);
  assert.equal(env.state.gameReplies.length,1);
  assert.match(env.state.gameReplies[0].text, /#1/);
  env.state.latest = '1.3.0';
  await env.fire('closed',2);
  assert.equal(env.state.gameReplies.length,3);
  assert.equal(env.state.gameReplies[0].id,env.state.gameReplies[1].id);
  assert.match(env.state.gameReplies[2].text, /Fixed in LateJoinPlus 1.3.0/);
  env.issues.get(1).state = 'open';
  env.issues.get(1).labels.push('regression');
  await env.fire('closed',2);
  assert.equal(env.state.gameReplies.length,4);
  assert.equal(env.state.gameReplies[0].id,env.state.gameReplies[3].id);
});

test('game replies only translate trusted release/duplicate markers to bounded text', () => {
  const {gameUpdates,gameMessageId}=require('./reports');
  const bot = {login:'github-actions[bot]',type:'Bot'};
  const updates=gameUpdates([
    {user:bot,body:'arbitrary text\n<!-- ljp-bot:released:1.2.3 -->'},
    {user:bot,body:'<!-- ljp-bot:duplicate:187 -->'},
    {user:bot,body:'<!-- ljp-bot:fix-ready:9.9.9 -->'},
    {user:{login:'outsider'},body:'<!-- ljp-bot:released:9.9.9 -->'}
  ]);
  assert.deepEqual(updates.map(u=>u.kind),['released','duplicate']);
  assert(!updates[0].text.includes('arbitrary'));
  assert.equal(gameMessageId(8,updates[0]),gameMessageId(8,{...updates[0]}));
  assert.notEqual(gameMessageId(9,updates[0]),gameMessageId(8,updates[0]));
});

(async () => {
  let failed = 0;
  for (const { name, fn } of tests) {
    try {
      await fn();
      console.log('PASS ' + name);
    } catch (error) {
      failed++;
      console.error('FAIL ' + name + '\n' + error.stack);
    }
  }
  console.log((tests.length - failed) + '/' + tests.length + ' passed');
  if (failed) process.exitCode = 1;
})();
