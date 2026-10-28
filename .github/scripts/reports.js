'use strict';

const { createHash, randomBytes } = require('node:crypto');

const OUTSIDER_LIMIT_ENDS = '2027-04-28';
const GITHUB_TOKEN_ENDS = '2027-10-28';
const RELAY = 'https://ljp-reports.ricketywrecked.workers.dev';
const RELAY_TIMEOUT_MS = 10000;

const ENDPOINT =
  'https://thunderstore.io/api/experimental/package/RicketyWrecked/LateJoinPlus/';
const FIX = /^fixed-in:(\d+(?:\.\d+){1,3})$/;
const SIG = /^sig-[0-9a-f]{7}$/;
const LIMIT = 1000;
const BOT = 'github-actions[bot]';
const COLORS = {
  regression: 'd73a4a',
  'old-version': 'fbca04',
  'fixed-already': '0e8a16',
  test: 'c5def5',
  'needs-info': 'd4c5f9',
  manual: 'bfdadc',
  'removal-request': 'b60205',
  dashboard: '5319e7',
  duplicate: 'ededed',
};

function parseReport(body) {
  const fields = {};
  const sections = {};
  let section = '';
  let fence = 0;
  let header = true;
  for (const line of String(body || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (fence) {
      const close = line.match(/^\s*(\x60{3,})\s*$/);
      if (close && close[1].length >= fence) {
        fence = 0;
      } else if (section) {
        sections[section].push(line);
      }
      continue;
    }
    const heading = line.match(/^###\s+(.+?)\s*$/);
    if (heading) {
      header = false;
      section = heading[1];
      if (!sections[section]) sections[section] = [];
      continue;
    }
    const open = line.match(/^\s*(\x60{3,})[^\x60]*$/);
    if (open) {
      fence = open[1].length;
      continue;
    }
    if (header) {
      const row = line.match(/^\s*\|\s*([^|]+?)\s*\|\s*(.*?)\s*\|\s*$/);
      if (row) fields[row[1].trim()] = row[2].trim();
    }
  }
  if (!Object.hasOwn(fields, 'Report')) return null;
  const errors = (sections['Errors in this session'] || [])
    .map(line => line.trim())
    .filter(line => line && !/^(?:(?:there (?:were|are) )?none[.!]?|(?:there (?:were|are) )?no errors\b.*|No matching error lines\.)$/i.test(line));
  return {
    version: (fields.Mod || '').replace(/^LateJoinPlus\s+/i, '').trim(),
    game: fields.Game || '',
    role: fields.Role || '',
    level: fields.Level || '',
    players: fields.Players || '',
    language: fields.Language || '',
    category: fields.Category || '',
    reportId: fields.Report || '',
    description: (sections["Player's description"] || sections.Description || []).join('\n').trim(),
    errors,
  };
}

function signature(report) {
  const lines = (report.errors || []).map(line => line.trim()).filter(Boolean);
  if (!lines.length) return null;
  function normalize(value, frame = false) {
    let result = value
      .replace(/\[\d{2}:\d{2}:\d{2}(?:\.\d+)?\]\s*/g, '')
      .replace(/\[\s*Error\s*:\s*([^\]]+)\]/gi, '$1');
    if (frame) {
      result = result.replace(/\[\s*0x[0-9a-f]+\s*\]/gi, '');
      while (/<[^<>]*>/.test(result)) result = result.replace(/<[^<>]*>/g, '');
    }
    return result
      .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, 'X')
      .replace(/\b0x[0-9a-f]+\b/gi, 'X')
      .replace(/\b[0-9a-f]{8,}\b/gi, 'X')
      .replace(/\d+/g, 'N')
      .replace(/\s+/g, ' ')
      .trim();
  }
  const frame = lines.slice(1).find(line => /^at\s+/.test(line));
  const key = normalize(lines[0]) + (frame ? '\n' + normalize(frame, true) : '');
  return 'sig-' + createHash('sha1').update(key).digest('hex').slice(0, 7);
}

function validVersion(value) {
  return typeof value === 'string' && /^\d+(?:\.\d+)*$/.test(value) &&
    value.length <= 50;
}

function compareVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) {
    throw new TypeError('Expected numeric dotted versions');
  }
  const left = a.split('.').map(BigInt);
  const right = b.split('.').map(BigInt);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] || 0n;
    const y = right[i] || 0n;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function isTestReport(report) {
  const value = report.description.trim().toLowerCase();
  return value === 'test' || value === 'testing' || value.startsWith('setup test');
}

const labels = issue => (issue.labels || []).map(label =>
  typeof label === 'string' ? label : label.name);
const has = (issue, name) => labels(issue).includes(name);
const sigOf = issue => labels(issue).find(name => SIG.test(name));
const fixes = issue => labels(issue).map(name => name.match(FIX))
  .filter(Boolean).map(match => match[1]).sort(compareVersions);
const fixOf = issue => fixes(issue).at(-1);
const oldest = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) ||
  a.number - b.number;
const excluded = issue => ['test', 'dashboard', 'manual', 'removal-request']
  .some(name => has(issue, name));
const marker = (kind, key) => '<!-- ljp-bot:' + kind + ':' + key + ' -->';
const trusted = comment => comment.user?.login === BOT && comment.user?.type === 'Bot';
const versionText = value => validVersion(value) ? value : 'unknown';
const shortField = value => /^[a-zA-Z0-9 _-]{1,40}$/.test(value) ? value : 'unknown';
const dateText = value => /^\d{4}-\d\d-\d\dT/.test(value || '') ?
  value.slice(0, 10) : 'unknown';

function cell(value, limit = 120) {
  return String(value || '—').split(/\r?\n/)[0].slice(0, limit)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '&#64;').replace(/\|/g, '&#124;')
    .replace(/([\\\x60*_[\]~])/g, '\\$1');
}

function table(headers, rows) {
  return [
    '| ' + headers.join(' | ') + ' |',
    '| ' + headers.map(() => '---').join(' | ') + ' |',
    ...(rows.length ? rows.map(row => '| ' + row.join(' | ') + ' |') :
      ['| None | ' + headers.slice(1).map(() => '—').join(' | ') + ' |']),
  ].join('\n');
}

function storedRelay(body) {
  // Accept only our timestamp format and fixed reasons; never echo arbitrary text.
  const match = String(body || '').match(
    /^<!-- relay:(ok|fail):(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)(?::(HTTP [1-5]\d\d|timeout|not JSON|closed|invalid response|network error))? -->$/m);
  if (!match || (match[1] === 'fail') !== Boolean(match[3])) return null;
  const date = new Date(match[2]);
  if (!Number.isFinite(date.getTime()) ||
      date.toISOString().replace('.000Z', 'Z') !== match[2]) return null;
  return { ok: match[1] === 'ok', checked: match[2], reason: match[3] };
}

function relayLines(result) {
  if (!result) return [];
  const { ok, checked, reason } = result;
  return [
    ok ? 'Relay: OK (checked ' + checked + ')' :
      '**Relay problem:** ' + reason + ' (checked ' + checked +
        '). Reports from the game may be failing.',
    '<!-- relay:' + (ok ? 'ok:' : 'fail:') + checked +
      (ok ? '' : ':' + reason) + ' -->',
  ];
}

async function checkRelay(fetch, now) {
  const checked = now.toISOString().replace(/\.\d{3}Z$/, 'Z');
  async function request(path, body) {
    const signal = AbortSignal.timeout(RELAY_TIMEOUT_MS);
    try {
      const response = await fetch(RELAY + path, {
        method: body ? 'POST' : 'GET',
        headers: { Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}) },
        redirect: 'error',
        signal,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      // Only the dry run may be rate limited and still count as healthy.
      if (body && response.status === 429) return null;
      if (!response.ok) {
        return Number.isInteger(response.status) &&
          response.status >= 100 && response.status <= 599 ?
          'HTTP ' + response.status : 'invalid response';
      }
      let data;
      try {
        data = await response.json();
      } catch (error) {
        if (signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name)) {
          return 'timeout';
        }
        return 'not JSON';
      }
      if (!body && data?.open === false) return 'closed';
      if (data?.ok !== true || (body ? data?.dryRun !== true :
          data?.service !== 'ljp-reports' || data?.open !== true)) {
        return 'invalid response';
      }
      return null;
    } catch (error) {
      return signal.aborted || ['TimeoutError', 'AbortError'].includes(error?.name) ?
        'timeout' : 'network error';
    }
  }
  let reason = await request('/');
  if (!reason) {
    reason = await request('/report', {
      v: 1, mod: 'LateJoinPlus', modVersion: '0.0', gameVersion: '0.0',
      installId: randomBytes(16).toString('hex'), category: 'other',
      description: 'health check', role: 'menu', level: '', players: 0,
      language: 'en-US', mods: [], log: '', test: true,
    });
  }
  return { ok: !reason, checked, reason };
}

function reminders(now) {
  const today = now.toISOString().slice(0, 10);
  const days = date => (Date.parse(date + 'T00:00:00Z') -
    Date.parse(today + 'T00:00:00Z')) / 86400000;
  const lines = [];
  if (days(OUTSIDER_LIMIT_ENDS) <= 30) {
    lines.push('- ' + (OUTSIDER_LIMIT_ENDS < today ?
      '**Only-you limit on issues/comments ended ' + OUTSIDER_LIMIT_ENDS + '**' :
      'Only-you limit on issues/comments ends ' + OUTSIDER_LIMIT_ENDS) +
      ': renew it (see the check-reports notes).');
  }
  if (days(GITHUB_TOKEN_ENDS) <= 30) {
    lines.push('- ' + (GITHUB_TOKEN_ENDS < today ?
      "**The relay's GitHub token expired " + GITHUB_TOKEN_ENDS + '**' :
      "The relay's GitHub token expires " + GITHUB_TOKEN_ENDS) +
      ': make a new one and run `npx wrangler secret put GITHUB_TOKEN` in tools/bug-relay.');
  }
  return lines.length ? ['**Reminders**', lines.join('\n')] : [];
}

async function run({ github, context, core, fetch, now = new Date() }) {
  const api = github.rest.issues;
  const repo = context.repo;
  const commentCache = new Map();
  const ensured = new Set();
  let latestPromise;
  let capped = false;

  async function list(extra = {}) {
    let count = 0;
    return github.paginate(api.listForRepo, {
      ...repo, state: 'all', per_page: 100,
      sort: 'created', direction: 'desc', ...extra,
    }, (response, done) => {
      const items = response.data.slice(0, LIMIT - count);
      count += items.length;
      if (count >= LIMIT) {
        capped = true;
        done();
      }
      return items.filter(issue => !issue.pull_request);
    });
  }

  async function latest() {
    if (!latestPromise) {
      latestPromise = (async () => {
        try {
          const response = await fetch(ENDPOINT, {
            headers: { Accept: 'application/json' },
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) throw new Error('HTTP failure');
          const version = (await response.json())?.latest?.version_number;
          if (!validVersion(version)) throw new Error('Invalid version');
          return version;
        } catch {
          core.warning('Thunderstore is unavailable; release closing is skipped this run.');
          return null;
        }
      })();
    }
    return latestPromise;
  }

  async function ensureLabel(name) {
    if (ensured.has(name)) return;
    try {
      await api.getLabel({ ...repo, name });
    } catch (error) {
      if (error.status !== 404) throw error;
      try {
        await api.createLabel({
          ...repo, name,
          color: COLORS[name] || (FIX.test(name) ? '0e8a16' : 'ededed'),
          description: SIG.test(name) ? 'Same error' :
            (FIX.test(name) ? 'Fix release version' : name.replace(/-/g, ' ')),
        });
      } catch (createError) {
        if (createError.status !== 422) throw createError;
        // Another actor may have created it between our GET and POST.
        await api.getLabel({ ...repo, name });
      }
    }
    ensured.add(name);
  }

  async function add(issue, name) {
    await ensureLabel(name);
    if (has(issue, name)) return;
    await api.addLabels({ ...repo, issue_number: issue.number, labels: [name] });
    issue.labels = [...(issue.labels || []), { name }];
  }

  async function remove(issue, name) {
    if (!has(issue, name)) return;
    try {
      await api.removeLabel({ ...repo, issue_number: issue.number, name });
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    issue.labels = (issue.labels || []).filter(label =>
      (typeof label === 'string' ? label : label.name) !== name);
  }

  async function update(issue, change) {
    const response = await api.update({ ...repo, issue_number: issue.number, ...change });
    Object.assign(issue, response.data);
  }

  async function close(issue, reason) {
    if (issue.state !== 'closed' || issue.state_reason !== reason) {
      await update(issue, { state: 'closed', state_reason: reason });
    }
  }

  async function lock(issue) {
    if (has(issue, 'dashboard') || issue.locked) return;
    await api.lock({ ...repo, issue_number: issue.number });
    issue.locked = true;
  }

  async function comments(issue) {
    if (!commentCache.has(issue.number)) {
      commentCache.set(issue.number, await github.paginate(api.listComments, {
        ...repo, issue_number: issue.number, per_page: 100,
      }));
    }
    return commentCache.get(issue.number);
  }

  async function marked(issue, kind, key) {
    const tag = marker(kind, key);
    return (await comments(issue)).some(comment =>
      trusted(comment) && (comment.body || '').split('\n').includes(tag));
  }

  async function once(issue, kind, key, message) {
    if (await marked(issue, kind, key)) return;
    const response = await api.createComment({
      ...repo, issue_number: issue.number,
      body: message + '\n\n' + marker(kind, key),
    });
    (await comments(issue)).push(response.data);
  }

  async function duplicate(issue, original) {
    await add(issue, 'duplicate');
    await once(issue, 'duplicate', original.number,
      'Same problem as #' + original.number + ' — following it there. Thanks!');
    await close(issue, 'not_planned');
  }

  async function regression(original, issue, report) {
    await add(original, 'regression');
    // These fixes demonstrably failed. Keeping them would immediately re-close
    // the reopened issue on the next daily release check.
    for (const version of fixes(original)) {
      if (compareVersions(version, report.version) <= 0) {
        await remove(original, 'fixed-in:' + version);
      }
    }
    if (original.state !== 'open') await update(original, { state: 'open' });
    await duplicate(issue, original);
  }

  async function opened(issue) {
    if (has(issue, 'dashboard')) return;
    const report = parseReport(issue.body);
    if (!report) {
      if (issue.title.startsWith('Remove report')) {
        await add(issue, 'removal-request');
        await once(issue, 'removal', issue.number, 'Thanks — the owner will remove it.');
      } else {
        await add(issue, 'manual');
      }
      return;
    }
    if (isTestReport(report)) {
      await add(issue, 'test');
      await once(issue, 'test', issue.number, 'Test report received — closing it.');
      await close(issue, 'completed');
      return;
    }

    // Resume a partially completed close without repeating routing or reopening
    // an original that may since have received another fix.
    for (const comment of await comments(issue)) {
      if (!trusted(comment)) continue;
      const duplicateTag = (comment.body || '').match(/^<!-- ljp-bot:duplicate:(\d+) -->$/m);
      const fixedTag = (comment.body || '').match(/^<!-- ljp-bot:fixed-already:([\d.]+) -->$/m);
      if (duplicateTag || fixedTag) {
        await add(issue, duplicateTag ? 'duplicate' : 'fixed-already');
        await close(issue, duplicateTag ? 'not_planned' : 'completed');
        return;
      }
    }

    const sig = signature(report);
    if (sig) await add(issue, sig);
    const current = await latest();
    if (current && validVersion(report.version) &&
        compareVersions(report.version, current) < 0) {
      await add(issue, 'old-version');
      await once(issue, 'old-version', current,
        'This was sent from LateJoinPlus ' + report.version + ', and ' + current +
        ' is out. Please update in r2modman; if it still happens, send a new report from the game.');
    }
    if (!sig) return;

    const candidates = (await list({ labels: sig, direction: 'asc' }))
      .filter(other => other.number !== issue.number &&
        !has(other, 'test') && !has(other, 'dashboard'))
      .sort(oldest);
    const original = candidates[0];
    // An opened event can arrive late: never make an older issue point forward.
    if (!original || oldest(original, issue) >= 0) return;

    if (validVersion(report.version) &&
        await marked(original, 'regression', issue.number)) {
      await regression(original, issue, report);
      return;
    }
    if (original.state === 'open') {
      await once(original, 'seen', issue.number,
        'Seen again in #' + issue.number + ' (v' + versionText(report.version) +
        ', ' + shortField(report.role) + ', ' +
        (/^\d{1,6}$/.test(report.players) ? report.players : 'unknown') +
        ' players, ' + shortField(report.language) + ').');
      await duplicate(issue, original);
      return;
    }
    const fixed = fixOf(original);
    if (fixed && validVersion(report.version)) {
      if (compareVersions(report.version, fixed) >= 0) {
        // Record intent before mutating state, so a failed run can resume it.
        await once(original, 'regression', issue.number,
          'It happened again in v' + report.version + ' (#' + issue.number +
          '), after the fix in ' + fixed + '.');
        await regression(original, issue, report);
      } else {
        await add(issue, 'fixed-already');
        await once(issue, 'fixed-already', fixed,
          'This is fixed in LateJoinPlus ' + fixed + '. Please update in r2modman.');
        await close(issue, 'completed');
      }
      return;
    }
    await once(issue, 'related', original.number, 'Looks like #' + original.number + '.');
  }

  async function releaseCheck(issues) {
    const current = await latest();
    if (!current) return;
    for (const issue of issues) {
      if (issue.state !== 'open' || has(issue, 'dashboard')) continue;
      // Multiple fix labels mean the newest promised fix must be released.
      const fixed = fixOf(issue);
      if (!fixed || compareVersions(current, fixed) < 0) continue;
      await once(issue, 'released', fixed,
        'Fixed in LateJoinPlus ' + fixed +
        ' — update in r2modman. If it still happens, send a new report from the game.');
      await remove(issue, 'regression');
      await close(issue, 'completed');
    }
  }

  async function dashboard() {
    const current = await latest();
    const all = await list();
    let dash = all.filter(issue =>
      has(issue, 'dashboard') && issue.title === 'Report dashboard').sort(oldest)[0];
    if (!dash) {
      dash = (await list({ labels: 'dashboard', direction: 'asc' }))
        .filter(issue => issue.title === 'Report dashboard').sort(oldest)[0];
    }

    const problems = all.filter(issue => !excluded(issue));
    const groups = new Map();
    const needs = [];
    const waiting = [];
    const recent = [];
    const cutoff = now.getTime() - 14 * 86400000;
    const unusual = all.filter(issue =>
      issue.state === 'closed' && !has(issue, 'dashboard') && !has(issue, 'manual') &&
      (has(issue, 'test') || has(issue, 'duplicate')) && parseReport(issue.body) &&
      Date.parse(issue.closed_at) >= now.getTime() - 86400000 &&
      Date.parse(issue.closed_at) <= now.getTime()).length;
    for (const issue of problems) {
      const report = parseReport(issue.body);
      const fixed = fixOf(issue);
      if (issue.state === 'open') {
        const sig = sigOf(issue);
        const key = sig || 'issue-' + issue.number;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(issue);
        if (fixed) waiting.push([issue, fixed]);
        if (report && !sig && !signature(report) && !report.description.trim()) {
          await add(issue, 'needs-info');
          needs.push(issue);
        }
      } else if (fixed && Date.parse(issue.closed_at) >= cutoff &&
                 Date.parse(issue.closed_at) <= now.getTime()) {
        recent.push([issue, fixed]);
      }
    }

    const rows = [];
    for (const [key, open] of groups) {
      open.sort(oldest);
      const root = open[0];
      const numbers = new Set(open.map(issue => String(issue.number)));
      const seen = [...open];
      if (SIG.test(key)) {
        for (const issue of problems) {
          if (issue.state !== 'closed' || !has(issue, 'duplicate') ||
              sigOf(issue) !== key) continue;
          const pointsHere = (await comments(issue)).some(comment => {
            if (!trusted(comment)) return false;
            const match = (comment.body || '').match(/^<!-- ljp-bot:duplicate:(\d+) -->$/m);
            return match && numbers.has(match[1]);
          });
          if (pointsHere) seen.push(issue);
        }
      }
      const versions = [...new Set(seen.map(issue => parseReport(issue.body)?.version)
        .filter(validVersion))].sort(compareVersions);
      const last = seen.map(issue => issue.created_at).sort().at(-1);
      rows.push({
        count: seen.length, last, number: root.number,
        values: ['#' + root.number, String(seen.length),
          versions.join(', ') || 'unknown', dateText(last),
          cell(parseReport(root.body)?.category || 'unknown', 40), cell(root.title)],
      });
    }
    rows.sort((a, b) => b.count - a.count ||
      String(b.last).localeCompare(String(a.last)) || a.number - b.number);
    waiting.sort((a, b) => oldest(a[0], b[0]));
    needs.sort(oldest);
    recent.sort((a, b) => String(b[0].closed_at).localeCompare(String(a[0].closed_at)));
    const relay = ['schedule', 'workflow_dispatch'].includes(context.eventName) ?
      await checkRelay(fetch, now) : storedRelay(dash?.body);
    const body = [
      ...relayLines(relay),
      ...reminders(now),
      ...(unusual > 20 ? ['Unusual volume in the last 24 h: ' + unusual + ' reports.'] : []),
      'Updated ' + now.toISOString() + '. Latest LateJoinPlus on Thunderstore: ' +
        (current || 'unavailable') + '.',
      ...(capped ? ['Issue scans are limited to 1,000 entries; older reports may be omitted.'] : []),
      '**Open problems**',
      table(['Issue', 'Seen', 'Versions', 'Last seen', 'Category', 'Title'],
        rows.slice(0, 50).map(row => row.values)),
      '**Fix waiting for release**',
      table(['Issue', 'Version'], waiting.map(([issue, fixed]) =>
        ['#' + issue.number, fixed])),
      '**Fixed in the last 14 days**',
      table(['Issue', 'Version', 'Closed'], recent.map(([issue, fixed]) =>
        ['#' + issue.number, fixed, dateText(issue.closed_at)])),
      '**Needs info**',
      table(['Issue', 'Date'], needs.map(issue =>
        ['#' + issue.number, dateText(issue.created_at)])),
    ].join('\n\n');

    await ensureLabel('dashboard');
    if (!dash) {
      dash = (await api.create({
        ...repo, title: 'Report dashboard', body, labels: ['dashboard'],
      })).data;
    } else {
      await update(dash, { body });
    }
    try {
      await github.graphql(
        'mutation($id: ID!) { pinIssue(input: {issueId: $id}) { issue { id } } }',
        { id: dash.node_id });
    } catch {
      core.info('Dashboard pinning was unavailable; the dashboard is still updated.');
    }
  }

  try {
    if (context.eventName === 'issues') {
      const payload = context.payload;
      if (payload.issue && !payload.issue.pull_request) {
        // Refresh mutable state: queued events can contain stale labels/state.
        const issue = (await api.get({
          ...repo, issue_number: payload.issue.number,
        })).data;
        const outsider = payload.issue.user?.login !== repo.owner;
        try {
          if (!has(issue, 'dashboard') && outsider) {
            // The relay posts as the owner. A copied report body is not proof of origin.
            await add(issue, 'manual');
            await once(issue, 'game-only', issue.number,
              'Please send reports from the game (LateJoinPlus menu → Send a bug report). ' +
              'For anything else, use the LateJoinPlus Discord.');
            await close(issue, 'not_planned');
          } else {
            if (payload.action === 'opened') await opened(issue);
            if (payload.action === 'labeled') {
              const match = String(payload.label?.name || '').match(FIX);
              if (match && has(issue, match[0]) && !has(issue, 'dashboard')) {
                await ensureLabel(match[0]);
                await once(issue, 'fix-ready', match[1],
                  'A fix is ready and will be in LateJoinPlus ' + match[1] + '.');
                await releaseCheck([issue]);
              }
            }
          }
        } finally {
          // Protect every triage exit, including partial failures and retries.
          if (outsider || parseReport(issue.body)) await lock(issue);
        }
      }
    } else if (['schedule', 'workflow_dispatch'].includes(context.eventName)) {
      await releaseCheck(await list());
    }
  } finally {
    // Re-read after mutations; bot-generated events do not run another workflow.
    await dashboard();
  }
}

module.exports = { run, parseReport, signature, compareVersions, isTestReport };
