'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  run, parseReport, signature, compareVersions, isTestReport, errorSource, sourceInfo,
  alertMessage,
} = require('./reports');

const NOW = new Date('2026-10-28T06:17:00Z');
const DAY = 86400000;
const RELAY = 'https://ljp-reports.ricketywrecked.workers.dev';
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
  const outputs = [];
  const state = {
    latest, fetchMode: 'ok', pinFails: false, failClose: 0, raceLabel: null,
    fetchCount: 0, failAdd: null, failLock: 0,
    now: new Date(NOW), relayCalls: [], relayGet: 'ok', relayPost: 'ok',
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
    rest: { issues: api },
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
    issues, labels, comments, calls, warnings, infos, outputs, state, github,
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
        github, now: state.now,
        context: {
          repo: { owner: 'HardStyleMoose', repo: 'RicketyWrecked-reports' },
          eventName,
          payload: { action, issue: clone(issues.get(number)), label: { name: label } },
        },
        core: {
          warning: message => warnings.push(message), info: message => infos.push(message),
          setOutput: (name, value) => outputs.push({ name, value }),
        },
        fetch: async (url, options) => {
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
  const rest = env.dashboard().body.split('### ' + title + '\n\n')[1];
  return rest === undefined ? '' : rest.split('\n\n### ')[0].split('\n\nUpdated ')[0];
}

// The dashboard after its summary block: the relay result comes first there.
const afterSummary = env => env.dashboard().body.split('\n\n').slice(1).join('\n\n');

// One open-problem entry: its three lines, starting at the issue number.
function entry(env, number) {
  const open = section(env, 'Open problems');
  const start = open.indexOf('- **#' + number + '** ');
  return start < 0 ? '' : open.slice(start).split('\n- ')[0];
}

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
  assert(entry(env, 1).startsWith('- **#1** · **2×** · Unity Log (game or any mod)\n' +
    '  last seen 2026-01-01 (300 days ago) · v1.1.0, 1.2.0 · other\n'));
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
  assert(entry(env, 1).startsWith('- **#1** · **1×** · no errors logged\n'));
  assert(entry(env, 2).startsWith('- **#2** · **1×** · no errors logged\n'));
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
  assert.equal(section(env, 'Fix waiting for release'), '- #1 · fix in 1.10.0');
  env.state.latest = '1.10.0';
  await env.fire(null, null, null, 'workflow_dispatch');
  await env.fire(null, null, null, 'workflow_dispatch');
  assert.equal(env.count(1, 'released'), 1);
  assert.equal(env.issues.get(1).state_reason, 'completed');
  assert(!has(env.issues.get(1), 'regression'));
  assert(commentText(env, 1).includes(
    'Fixed in LateJoinPlus 1.10.0 — update in r2modman. If it still happens, send a new report from the game.'));
  assert.equal(section(env, 'Fixed in the last 14 days'),
    '- #1 · fixed in 1.10.0 · closed 2026-10-28');
  assert.equal(section(env, 'Fix waiting for release'), '');
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
  assert(entry(env, 1).startsWith('- **#1** · **3×** · Unity Log (game or any mod)\n' +
    '  last seen 2026-01-01 (300 days ago) · v1.9.0, 1.10.0 · other\n'));
  assert(!open.includes('8.0'));
  assert(!open.includes('v9.0'));
  assert(open.indexOf('**#1**') < open.indexOf('**#10**'));
  assert(open.indexOf('**#10**') < open.indexOf('**#9**'));
  for (const number of [6, 7, 8]) assert(!open.includes('**#' + number + '**'));
  assert(env.dashboard().body.startsWith('## 3 open problems (5 reports)\n' +
    '0 from our mods · 3 from other mods or the game · 0 new reports in the last 24 h'));
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
  assert.equal(section(env, 'Needs info'), '- #1 · sent 2026-01-01');
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
  assert.equal(section(env, 'Fix waiting for release'), '- #1 · fix in 9.0');
  assert.equal(section(env, 'Fixed in the last 14 days'),
    '- #2 · fixed in 1.0 · closed 2026-10-15');
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
  assert(dash.body.startsWith('## No open problems\n'));
  assert(dash.body.endsWith('Updated 2026-10-28T06:17:00.000Z. ' +
    'Latest LateJoinPlus on Thunderstore: 1.2.0.'));
  assert.equal(section(env, 'Open problems'), 'None.');
  for (const title of ['Fix waiting for release', 'Fixed in the last 14 days', 'Needs info']) {
    assert(!dash.body.includes(title));
  }
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
  assert.equal((open.match(/^- \*\*#/gm) || []).length, 50);
  assert(!open.includes('**#61**'));
  assert(open.includes('**#60**'));
  assert(open.endsWith('\n\n…and 10 more with fewer reports.'));
  assert(env.dashboard().body.startsWith('## 60 open problems (60 reports)\n'));
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
  assert(!section(env, 'Open problems').includes('**#2**'));
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
      'Please send reports from the game (LateJoinPlus menu → Send a bug report). ' +
      'For anything else, use the LateJoinPlus Discord.\n\n' + tag('game-only', 1));
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
  assert(env.dashboard().body.split('\n\n')[1] === 'Unusual volume in the last 24 h: 21 reports.');
});

test('dashboard displays the error title without rewriting it', async () => {
  const title = '[1.2.0] other: NullReferenceException: value 42';
  const env = fake([issue(1, { title })]);
  await env.fire();
  assert(entry(env, 1).endsWith('\n  \\[1.2.0\\] other: NullReferenceException: value 42'));
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
    assert(afterSummary(env).startsWith('Relay: OK (checked 2026-10-28T06:17:00Z)'));
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
  assert(afterSummary(env).startsWith('Relay: OK'));
  env.state.relayGet = 429;
  env.state.relayCalls = [];
  await env.fire(null, null, null, 'schedule');
  assert(afterSummary(env).startsWith('**Relay problem:** HTTP 429'));
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
      assert(afterSummary(env).startsWith('**Relay problem:** ' + reason +
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
    const first = env.dashboard().body.split('\n\n').slice(1, 3);
    env.state.now = new Date('2026-10-29T12:00:00Z');
    env.state.relayCalls = [];
    for (const action of ['opened', 'closed', 'reopened', 'labeled']) {
      await env.fire(action, env.dashboard().number);
      assert.deepEqual(env.dashboard().body.split('\n\n').slice(1, 3), first);
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
  assert(afterSummary(env).startsWith('Relay: OK (checked 2026-10-29T06:17:00Z)'));
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

const repolib = '[16:18:35.8448118] [Error  :   REPOLib] HarmonyLib.HarmonyException: ' +
  'Patching exception in method null\n  at HarmonyLib.PatchClassProcessor.Patch () [0x0006a]';
const ourError = '[16:19:02.1] [Error  :LateJoinPlus] NullReferenceException: value 7\n  at Late.Join ()';
const alerts = env => env.outputs.filter(output => output.name === 'discord')
  .map(output => output.value);

test('error source comes from the [Error  :Source] tag, padded or not', () => {
  for (const [line, name] of [
    ['[16:18:35.8448118] [Error  :   REPOLib] HarmonyLib.HarmonyException: x', 'REPOLib'],
    ['[Error  :LateJoinPlus] Boom', 'LateJoinPlus'],
    ['[01:02:03] [Error  : Unity Log] NullReferenceException', 'Unity Log'],
    ['[Error:R.E.P.O Fixes+] x', 'R.E.P.O Fixes+'],
    ['  [Fatal  :Lobby  Guard] x', 'Lobby Guard'],
    ['[error : Some_Mod-2] x', 'Some_Mod-2'],
  ]) {
    assert.equal(errorSource(line), name, line);
  }
  for (const line of [
    'NullReferenceException without a tag', '[Info   :LateJoinPlus] not an error',
    'at Foo.Bar ()', '[Error  :] empty', '[Error  :<@123>] mention',
    '[Error  :\x60code\x60] tick', '[Error  :**bold**] md', '[Error  :x(https://e.com)] link',
    '[Error  :' + 'a'.repeat(41) + '] long', '[Error  :@everyone] ping',
    '[Error  :-dash] leading', '[Error  :ok‮] bidi', 'prefix [Error  :LateJoinPlus] later',
  ]) {
    assert.equal(errorSource(line), null, line);
  }
});

test('source info marks our mods, Unity Log and other mods, and our later errors', () => {
  const info = errors => sourceInfo(parseReport(report({ errors })));
  assert.deepEqual(info(repolib + '\n' + ourError + '\n[Error  :Lobby Guard] x\n' + ourError),
    { name: 'REPOLib', kind: 'other', also: ['LateJoinPlus', 'Lobby Guard'] });
  assert.deepEqual(info(ourError + '\n' + ourError), { name: 'LateJoinPlus', kind: 'ours', also: [] });
  assert.deepEqual(info('[Error  :R.E.P.O Fixes+] x'),
    { name: 'R.E.P.O Fixes+', kind: 'ours', also: [] });
  assert.deepEqual(info(defaultError), { name: 'Unity Log', kind: 'unity', also: [] });
  assert.deepEqual(info('Plain error\n' + ourError), { name: null, kind: 'unknown', also: ['LateJoinPlus'] });
  assert.deepEqual(info(null), { name: null, kind: 'none', also: [] });
  // Exact names only: a look-alike is somebody else's mod.
  assert.equal(info('[Error  :latejoinplus] x').kind, 'other');
});

test('signatures are unchanged by source detection and still split sources', () => {
  // Same hash as before this change: existing sig- labels keep grouping.
  const key = 'REPOLib HarmonyLib.HarmonyException: Patching exception in method null\n' +
    'at HarmonyLib.PatchClassProcessor.Patch ()';
  assert.equal(signature(parseReport(report({ errors: repolib }))),
    'sig-' + createHash('sha1').update(key).digest('hex').slice(0, 7));
  assert.notEqual(signature(parseReport(report({ errors: repolib.replace('REPOLib', 'Other') }))),
    signature(parseReport(report({ errors: repolib }))));
});

test('dashboard leads with counts and shows each problem source, regressions and age', async () => {
  const at = ms => new Date(NOW.getTime() - ms).toISOString();
  const ours = signature(parseReport(report({ errors: ourError })));
  const theirs = signature(parseReport(report({ errors: repolib })));
  const env = fake([
    issue(1, { labels: [theirs], body: report({ errors: repolib, category: 'crash', version: '1.1.0' }),
      title: '[1.1.0] crash: HarmonyLib.HarmonyException: Patching exception', created_at: at(3 * DAY) }),
    issue(2, { labels: [theirs, 'duplicate'], state: 'closed', created_at: at(DAY + 1000),
      body: report({ errors: repolib + '\n' + ourError, version: '1.1.5' }) }),
    issue(3, { labels: [ours, 'regression'], body: report({ errors: ourError }),
      title: '[1.2.0] other: NullReferenceException: value 7', created_at: at(60000) }),
    issue(4, { labels: ['test'], created_at: at(1000) }),
  ], '1.2.0');
  env.comments.set(2, [{ body: tag('duplicate', 1), user: bot }]);
  await env.fire('closed', 4);
  const body = env.dashboard().body;
  assert(body.startsWith('## 2 open problems (3 reports)\n**1 regression** · 1 from our mods · ' +
    '1 from other mods or the game · 1 new report in the last 24 h\n\n### Open problems\n\n'));
  assert.equal(entry(env, 1), '- **#1** · **2×** · REPOLib (other mod) · old versions only\n' +
    '  last seen 2026-10-27 (yesterday) · v1.1.0, 1.1.5 · crash · ' +
    'our mods also logged errors: LateJoinPlus\n' +
    '  \\[1.1.0\\] crash: HarmonyLib.HarmonyException: Patching exception');
  assert.equal(entry(env, 3), '- **#3** · **1×** · **LateJoinPlus** (ours) · **regression**\n' +
    '  last seen 2026-10-28 (today) · v1.2.0 · other\n' +
    '  \\[1.2.0\\] other: NullReferenceException: value 7');
  assert(section(env, 'Open problems').indexOf('**#1**') < section(env, 'Open problems').indexOf('**#3**'));
});

test('dashboard shows hostile or missing sources as unknown, escaped', async () => {
  const env = fake([
    issue(1, { body: report({ errors: '[Error  :<img src=x> @everyone] x' }) }),
    issue(2, { body: report({ errors: '[Error  :**bold**](https://e.com)] x' }) }),
    issue(3, { body: report({ errors: '[Error  :Some_Mod] x', category: '- list' }),
      title: '# heading 1. @person' }),
  ]);
  await env.fire('closed', 1);
  const body = env.dashboard().body;
  assert(entry(env, 1).startsWith('- **#1** · **1×** · unknown source\n'));
  assert(entry(env, 2).startsWith('- **#2** · **1×** · unknown source\n'));
  assert(entry(env, 3).startsWith('- **#3** · **1×** · Some\\_Mod (other mod)\n'));
  assert(entry(env, 3).endsWith('\n  \\# heading 1. &#64;person'));
  assert(entry(env, 3).includes(' · \\- list'));
  for (const text of ['<img', '@everyone', '**bold**', '](https']) assert(!body.includes(text));
});

test('cell escaping keeps entities intact and neutralizes line-start markdown', async () => {
  for (const [title, shown] of [
    ['a | b @c #1', 'a &#124; b &#64;c \\#1'], ['- item', '\\- item'], ['+ item', '\\+ item'],
    ['12. item', '12\\. item'], ['3) item', '3\\) item'], ['> quote', '&gt; quote'],
    ['=== x', '\\=== x'],
  ]) {
    const env = fake([issue(1, { title, body: report({ errors: null }) })]);
    await env.fire('closed', 1);
    assert(entry(env, 1).endsWith('\n  ' + shown), title);
  }
});

test('discord alert: new problem with version, category, source and link', async () => {
  const env = fake([issue(7, { body: report({ errors: repolib + '\n' + ourError, category: 'crash' }),
    title: '[1.2.0] crash: HarmonyLib.HarmonyException: Patching exception' })]);
  await env.fire('opened', 7);
  assert.deepEqual(alerts(env), [
    '🆕 **New problem** · #7\n' +
    'LateJoinPlus 1.2.0 · crash · from REPOLib (other mod) · our mods also logged errors: LateJoinPlus\n' +
    '\x60[1.2.0] crash: HarmonyLib.HarmonyException: Patching exception\x60\n' +
    'https://github.com/HardStyleMoose/RicketyWrecked-reports/issues/7',
  ]);
  const ours = fake([issue(1, { body: report({ errors: ourError }) })]);
  await ours.fire('opened', 1);
  assert(alerts(ours)[0].includes(' · other · from **LateJoinPlus** (ours)\n'));
});

test('discord alert says seen again, old version, regression, fixed already or related', async () => {
  const seen = fake([issue(1, { labels: [sig] }), issue(2, { body: report({ version: '1.1.0' }) })]);
  await seen.fire('opened', 2);
  assert.equal(alerts(seen)[0].split('\n').slice(0, 2).join('\n'),
    '🔁 **Seen again** · #2, same as #1\n' +
    'LateJoinPlus 1.1.0 (old: 1.2.0 is out) · other · from Unity Log (game or any mod)');

  const regression = fake([issue(1, { labels: [sig, 'fixed-in:1.2.0'], state: 'closed' }), issue(2)]);
  await regression.fire('opened', 2);
  assert(alerts(regression)[0].startsWith('⚠️ **Regression** · #2 reopened #1 (fixed in 1.2.0)\n'));

  const fixed = fake([issue(1, { labels: [sig, 'fixed-in:1.3.0'], state: 'closed' }), issue(2)]);
  await fixed.fire('opened', 2);
  assert(alerts(fixed)[0].startsWith('✅ **Already fixed** · #2, same as #1 (fixed in 1.3.0)\n'));

  const related = fake([issue(1, { labels: [sig], state: 'closed' }), issue(2)]);
  await related.fire('opened', 2);
  assert(alerts(related)[0].startsWith('🆕 **New report** · #2, looks like closed #1\n'));

  // A late opened event for the older issue is new, never "seen again" pointing forward.
  const late = fake([issue(1), issue(2, { labels: [sig] })]);
  await late.fire('opened', 1);
  assert(alerts(late)[0].startsWith('🆕 **New problem** · #1\n'));
});

test('discord alert on retries: resumed paths and failed triage still alert', async () => {
  const env = fake([issue(1, { labels: [sig] }), issue(2)]);
  env.state.failClose = 1;
  await assert.rejects(env.fire('opened', 2));
  assert(alerts(env)[0].startsWith('❗ **New report, not sorted** · #2 (triage failed, check it)\n'));
  await env.fire('opened', 2);
  assert(alerts(env)[1].startsWith('🔁 **Seen again** · #2, same as #1\n'));

  const regression = fake([issue(1, { labels: [sig, 'fixed-in:1.2.0'], state: 'closed' }), issue(2)]);
  regression.state.failAdd = 'regression';
  await assert.rejects(regression.fire('opened', 2));
  await regression.fire('opened', 2);
  assert(alerts(regression)[0].startsWith('❗ **New report, not sorted** · #2'));
  assert(alerts(regression)[1].startsWith('⚠️ **Regression** · #2 reopened #1 (fixed in 1.2.0)\n'));
});

test('no discord alert for tests, outsiders, hand-made issues, the dashboard or other events', async () => {
  const cases = [
    [issue(1, { body: report({ description: 'test' }) })],
    [issue(1, { body: report({ description: 'setup test 2' }) })],
    [issue(1, { user: { login: 'attacker', type: 'User' } })],
    [issue(1, { body: 'Hand-made', title: '[1.2.0] looks like a report' })],
    [issue(1, { body: 'remove', title: 'Remove report 1' })],
    [issue(1, { title: 'Report dashboard', labels: ['dashboard'] })],
  ];
  for (const items of cases) {
    const env = fake(items);
    await env.fire('opened', 1);
    assert.deepEqual(alerts(env), []);
  }
  const env = fake([issue(1, { labels: ['fixed-in:1.0'] })]);
  for (const action of ['labeled', 'reopened', 'closed']) await env.fire(action, 1, 'fixed-in:1.0');
  await env.fire(null, null, null, 'schedule');
  await env.fire(null, null, null, 'workflow_dispatch');
  assert.deepEqual(alerts(env), []);
});

test('discord alert never carries the description or log, and cleans hostile titles', async () => {
  const title = '\x60\x60\x60@everyone <@123> [click](https://evil.example) **x** ||y||\n' +
    'second​‮ line ' + 'z'.repeat(500);
  const env = fake([issue(1, {
    title,
    body: report({
      description: 'DESCSECRET @everyone https://evil.example',
      errors: '[Error  :LateJoinPlus] LOGSECRET first\n  at Frame.SECRET ()\n[Error  :Other] LOGTWO',
      version: '1.2.0\n@everyone', category: '**bold** @here', role: 'ROLESECRET',
      language: 'LANGSECRET', players: '99',
    }),
  })]);
  await env.fire('opened', 1);
  const [message] = alerts(env);
  for (const text of ['DESCSECRET', 'LOGSECRET', 'LOGTWO', 'Frame', 'ROLESECRET', 'LANGSECRET',
    '**bold**', '@here', '​', '‮', '\x60\x60']) {
    assert(!message.includes(text), text);
  }
  const lines = message.split('\n');
  assert.equal(lines.length, 4);
  assert.equal(lines[1], 'LateJoinPlus unknown · unknown · from **LateJoinPlus** (ours)');
  // The title sits alone in one inline code span, the only backticks in the message.
  assert.match(lines[2], /^\x60[^\x60]+\x60$/);
  assert.equal(lines[2].length, 152);
  assert(lines[2].endsWith('…\x60'));
  assert(lines[2].startsWith('\x60@everyone <@123> [click](https://evil.example)'));
  assert.equal(lines[3], 'https://github.com/HardStyleMoose/RicketyWrecked-reports/issues/1');
  assert(message.length < 400);
});

test('alertMessage validates every field it is given', () => {
  const message = alertMessage({
    status: 'nonsense', number: 5, title: '', url: 'https://github.com/o/r/issues/5',
    version: 'v1', category: 'a'.repeat(31), latest: '<1>', fixed: 'x', original: 0,
    source: { name: 'My_Mod', kind: 'other', also: [] },
  });
  assert.equal(message, '❗ **New report, not sorted** · #5 (triage failed, check it)\n' +
    'LateJoinPlus unknown · unknown · from My\\_Mod (other mod)\n\x60no title\x60\n' +
    'https://github.com/o/r/issues/5');
  assert(alertMessage({ status: 'new', number: 1, title: 't', url: 'u', version: '1.0',
    category: 'crash', source: { name: 'Unity Log', kind: 'unity', also: [] } })
    .includes(' · crash · from Unity Log (game or any mod)\n'));
  assert(alertMessage({ status: 'new', number: 1, title: 't', url: 'u', version: '1.0',
    category: 'crash', source: { name: null, kind: 'unknown', also: [] } })
    .includes(' · from unknown source\n'));
  assert(alertMessage({ status: 'new', number: 1, title: 't', url: 'u', version: '1.0',
    category: 'crash', source: { name: null, kind: 'none', also: [] } })
    .includes(' · crash · no errors logged\n'));
});

test('workflows keep minimal permissions and never put expressions in shell', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const dir = path.join(__dirname, '..', 'workflows');
  for (const file of ['reports.yml', 'discord.yml']) {
    const text = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const run = line.match(/^(\s*)(?:- )?run: *\|?\s*(.*)$/);
      if (!run) return;
      assert(!run[2].includes('${{'), file + ':' + (index + 1));
      for (const next of lines.slice(index + 1)) {
        if (next.trim() && next.search(/\S/) <= run[1].length) break;
        assert(!next.includes('${{'), file + ':' + (index + 1));
      }
    });
    assert.match(text, /^permissions: \{\}$/m, file);
    assert(!/contents: write|pull-requests|actions: write|id-token/.test(text), file);
  }
  const discord = fs.readFileSync(path.join(dir, 'discord.yml'), 'utf8');
  assert(discord.includes("allowed_mentions: {parse: []}, flags: 4"));
  assert(!discord.includes('github.event'));
  const reports = fs.readFileSync(path.join(dir, 'reports.yml'), 'utf8');
  const job = reports.slice(reports.indexOf('\n  discord:'));
  assert.match(job, /\n    permissions: \{\}\n/);
  assert((reports.match(/secrets\./g) || []).length === 1);
  assert(!reports.slice(0, reports.indexOf('\n  discord:')).includes('secrets.'));
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
