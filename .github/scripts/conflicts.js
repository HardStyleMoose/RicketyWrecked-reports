'use strict';

// Finds the other mod behind a report. Reports already carry everything needed (the mod list,
// the errors with their stack frames, and the "Who patches the methods in this log's errors"
// block), so no LateJoinPlus update is needed for this to work on new or old reports.
//
// Two kinds of result:
//   known    - a rule in conflicts/known-mods.json matched (installed version + evidence in the log).
//              The report is answered and closed; the mod goes on the Discord list.
//   suspect  - no rule, but the log points at a mod: its namespace in a stack frame, its own
//              [Error :Name] lines, or its patch on a method that failed. Labelled for the owner.
//
// Run by hand to try the rules against stored reports:  node .github/scripts/conflicts.js reports/2026/11/*.txt

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const OURS = /^ricketywrecked\./i;
// Libraries log other mods' mistakes ("Failed to register valuable"); they're never the suspect.
const LIBRARY = /^(?:REPOLib|MenuLib|nickklmao\.menulib|nickklmao\.repoconfig|BepInEx\.|com\.rune580\.reposteamnetworking|me\.loaforc\.soundapi)/i;
const OUR_SOURCES = new Set(['unity log', 'harmonyx', 'latejoinplus', 'r.e.p.o fixes+', 'lobby guard',
  'bepinex', 'player.log', 'rw test logger', 'rw musicbox']);
// Frames from these never name a mod; the first frame below them does.
const SYSTEM_FRAME = /^(?:(?:UnityEngine|System|HarmonyLib|Mono|MonoMod|Photon|ExitGames|BepInEx|TMPro|Steamworks|Unity)\.|\(wrapper)/;
const MAX_LABEL = 50;

function loadRules(file = path.join(__dirname, '..', '..', 'conflicts', 'known-mods.json')) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data.mods)) throw new Error('known-mods.json needs a "mods" list');
  if (data.harmless !== undefined && !Array.isArray(data.harmless)) {
    throw new Error('known-mods.json "harmless" must be a list');
  }
  for (const rule of data.harmless || []) {
    if (!rule || typeof rule.pattern !== 'string' || !rule.pattern.trim() ||
        typeof rule.why !== 'string' || !rule.why.trim()) {
      throw new Error('Every harmless rule needs pattern and why: ' + JSON.stringify(rule));
    }
    rule.harmlessRegex = new RegExp(rule.pattern, 'i');
  }
  for (const rule of data.mods) {
    if (!rule.guid || !rule.name || !rule.problem || !rule.fix) {
      throw new Error('Every rule needs guid, name, problem and fix: ' + JSON.stringify(rule));
    }
    rule.kind = rule.kind || 'broken';
    rule.regex = (rule.evidence || []).map(source => new RegExp(source, 'i'));
  }
  return data;
}

function parseMods(text) {
  const mods = [];
  const seen = new Set();
  for (const match of String(text || '').matchAll(/^-\s*"([^"\n]*)"\s*\|\s*"([^"\n]*)"\s*\|\s*"([^"\n]*)"\s*$/gm)) {
    const guid = match[2].trim();
    if (!guid || seen.has(guid.toLowerCase())) continue;
    seen.add(guid.toLowerCase());
    mods.push({ name: match[1].trim(), guid, version: match[3].trim() });
  }
  return mods;
}

const squash = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Name tokens a mod can be recognised by: "Pet Companion 宠物伙伴" -> petcompanion; guid segments.
function tokens(mod) {
  const result = new Set();
  const name = squash(mod.name);
  if (name.length >= 4) result.add(name);
  for (const part of String(mod.guid).split(/[.\-_]/)) {
    const value = squash(part);
    if (value.length >= 5 && !['plugin', 'plugins', 'github', 'repo', 'mods', 'mod'].includes(value)) result.add(value);
  }
  const whole = squash(mod.guid);
  if (whole.length >= 5) result.add(whole);
  return [...result];
}

function findMod(mods, text) {
  const value = squash(text);
  if (value.length < 4) return null;
  let best = null;
  for (const mod of mods) {
    if (OURS.test(mod.guid) || LIBRARY.test(mod.guid)) continue;
    for (const token of tokens(mod)) {
      if (value === token || value.includes(token) || (token.includes(value) && value.length >= 6)) {
        if (!best || token.length > best.score) best = { mod, score: token.length };
      }
    }
  }
  return best ? best.mod : null;
}

function versionBroken(installed, upTo) {
  if (!upTo) return true;
  const a = String(installed || '').match(/^\d+(?:\.\d+)*/);
  if (!a) return false; // An unknown version cannot establish that a capped rule applies.
  const left = a[0].split('.').map(Number);
  const right = String(upTo).split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const x = left[i] || 0;
    const y = right[i] || 0;
    if (x !== y) return x < y;
  }
  return true;
}

// Evidence in the log, without a rule.
function evidence(log, mods) {
  const found = new Map();
  const note = (mod, why) => {
    if (!mod || OURS.test(mod.guid) || LIBRARY.test(mod.guid)) return;
    if (!found.has(mod.guid)) found.set(mod.guid, { mod, why: [] });
    const list = found.get(mod.guid).why;
    if (list.length < 3 && !list.includes(why)) list.push(why);
  };
  const lines = String(log || '').replace(/\r\n?/g, '\n').split('\n');

  // 1. "Who patches the methods in this log's errors:" names the patcher of a failing method.
  let inWho = false;
  for (const line of lines) {
    if (/^Who patches the methods in this log's errors:/.test(line)) { inWho = true; continue; }
    if (inWho) {
      const row = line.match(/^\s+(\S+):\s+(.+)$/);
      if (!row) { inWho = false; continue; }
      for (const patcher of row[2].matchAll(/([A-Za-z0-9_.\-]+)\s*\((prefix|postfix|transpiler|finalizer|ilmanipulator)\)/g)) {
        if (OURS.test(patcher[1])) continue;
        const mod = mods.find(m => m.guid.toLowerCase() === patcher[1].toLowerCase()) || findMod(mods, patcher[1]);
        if (mod) note(mod, 'its ' + patcher[2] + ' on ' + row[1] + ' is in the error');
      }
    }
  }

  // 2. A mod logging its own errors: [Error  :Empress Spawn Browser], [Fatal :com.x.y].
  for (const line of lines) {
    const tag = line.match(/^\[(?:Error|Fatal)\s*:\s*([^\]]+?)\s*\]\s*(.*)$/);
    if (!tag || OUR_SOURCES.has(tag[1].toLowerCase())) continue;
    const mod = mods.find(m => m.guid.toLowerCase() === tag[1].toLowerCase() || m.name.toLowerCase() === tag[1].toLowerCase())
      || findMod(mods, tag[1]);
    if (mod) note(mod, 'it logged an error itself');
  }

  // 3. The first mod frame under a stack trace.
  for (let i = 0; i < lines.length; i++) {
    if (!/^Stack trace:/.test(lines[i])) continue;
    for (let j = i + 1; j < lines.length && j <= i + 12; j++) {
      const frame = lines[j].trim().replace(/^at\s+/, '');
      if (!frame || /^\[/.test(frame)) break;
      if (SYSTEM_FRAME.test(frame)) continue;
      const name = frame.replace(/^at\s+/, '').split(/\s*\(/)[0];
      const parts = name.split('.');
      if (parts.length < 3) break; // game code has no namespace
      const mod = findMod(mods, parts[0]) || findMod(mods, parts.slice(0, 2).join('')) || findMod(mods, parts[1]);
      if (mod) note(mod, 'the error comes from its code (' + parts.slice(0, -1).join('.') + ')');
      break;
    }
  }
  return [...found.values()];
}

function detect(log, mods, rules) {
  const text = String(log || '');
  const known = [];
  for (const rule of rules.mods) {
    const mod = mods.find(m => m.guid.toLowerCase() === rule.guid.toLowerCase());
    if (!mod || !versionBroken(mod.version, rule.brokenUpTo)) continue;
    const regex = rule.regex || (rule.evidence || []).map(source => new RegExp(source, 'i'));
    if (regex.length && !regex.some(re => re.test(text))) continue;
    known.push({ rule, mod });
  }
  const knownGuids = new Set(known.map(k => k.mod.guid.toLowerCase()));
  const suspects = evidence(text, mods).filter(s => !knownGuids.has(s.mod.guid.toLowerCase()));
  return { known, suspects };
}

function labelFor(guid) {
  const name = 'mod:' + String(guid).toLowerCase();
  // Truncation alone merges different GUIDs that share a long prefix.
  return name.length <= MAX_LABEL ? name : name.slice(0, MAX_LABEL - 13) + '-' +
    createHash('sha1').update(name).digest('hex').slice(0, 12);
}

// Our own mods logged an error of their own. The relay's "First error this session" line and
// "could not apply" (another mod broke a method our patch needs) describe other mods' breakage.
function ownErrors(log) {
  return String(log || '').split('\n').some(line =>
    /^\[(?:Error|Fatal)\s*:\s*(?:LateJoinPlus|R\.E\.P\.O Fixes\+|Lobby Guard)\s*\]/i.test(line) &&
    !/First error this session|could not apply/i.test(line));
}

// Only the parsed error section counts; stack frames are supporting context, not errors.
function harmlessOnly(errors, rules) {
  const reasons = new Set();
  for (const line of errors || []) {
    const text = line.trim();
    if (!text || /^(?:at\s|UnityEngine\.|System\.|HarmonyLib\.|Rethrow|\(wrapper|\(seen \d+ times)/.test(text)) continue;
    const rule = (rules.harmless || []).find(rule => rule.harmlessRegex.test(text));
    if (!rule) return null;
    reasons.add(rule.why);
  }
  return reasons.size ? [...reasons] : null;
}

function knownComment(known) {
  const lines = known.map(({ rule, mod }) =>
    '- **' + rule.name + ' ' + mod.version + '** (' + mod.guid + '): ' + rule.problem + ' ' + rule.fix);
  return 'Not a LateJoinPlus problem. Another mod in this list causes it:\n' + lines.join('\n') +
    '\n\nRemove or update it, then send a new report from the game if it still happens.';
}

function suspectComment(suspects) {
  const lines = suspects.map(({ mod, why }) =>
    '- **' + mod.name + ' ' + mod.version + '** (' + mod.guid + '): ' + why.join('; ') + '.');
  return 'The errors in this report point at another mod, not LateJoinPlus:\n' + lines.join('\n') +
    '\n\nThe owner will look at it. Try without that mod first.';
}

// ---- Discord ------------------------------------------------------------------------------

const KINDS = {
  broken: 'Broken on this game version (remove or update)',
  replaced: 'Not needed next to LateJoinPlus (it does this itself)',
  duplicate: 'Installed twice (keep one)',
};

function listMessage(rules, counts, now = new Date()) {
  const groups = new Map();
  for (const rule of rules.mods) {
    if (!groups.has(rule.kind)) groups.set(rule.kind, []);
    groups.get(rule.kind).push(rule);
  }
  const parts = ['**Known mod conflicts** (R.E.P.O ' + (rules.game || '0.5.1') +
    ', from bug reports; none of these errors come from LateJoinPlus or Fixes+). Updated ' +
    now.toISOString().slice(0, 10) + '.'];
  for (const [kind, list] of groups) {
    list.sort((a, b) => (counts.get(labelFor(b.guid).slice(4)) || 0) - (counts.get(labelFor(a.guid).slice(4)) || 0) || a.name.localeCompare(b.name));
    parts.push('\n__' + (KINDS[kind] || kind) + '__');
    for (const rule of list) {
      const n = counts.get(labelFor(rule.guid).slice(4)) || 0;
      parts.push('• **' + rule.name + '**' + (rule.brokenUpTo ? ' up to ' + rule.brokenUpTo : '') +
        ' – ' + rule.problem + (n ? ' (' + n + ' report' + (n === 1 ? '' : 's') + ')' : ''));
    }
  }
  let text = parts.join('\n');
  if (text.length > 1950) text = text.slice(0, 1900) + '\n… and more on GitHub.';
  return text;
}

function newMessage(rule, mod, issueNumber) {
  return '**New:** ' + rule.name + ' ' + mod.version + ' – ' + rule.problem + ' ' + rule.fix +
    ' (report #' + issueNumber + ')';
}

async function discordSend(fetch, webhook, content) {
  const response = await fetch(webhook + (webhook.includes('?') ? '&' : '?') + 'wait=true', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new Error('Discord post failed: HTTP ' + response.status);
  return (await response.json()).id;
}

async function discordEdit(fetch, webhook, messageId, content) {
  const base = webhook.split('?')[0];
  const response = await fetch(base + '/messages/' + messageId, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, allowed_mentions: { parse: [] }, flags: 4 }),
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return false; // the message was deleted in Discord: post a new one
  if (!response.ok) throw new Error('Discord edit failed: HTTP ' + response.status);
  return true;
}

// ---- CLI: node conflicts.js reports/2026/11/*.txt ------------------------------------------

if (require.main === module) {
  const rules = loadRules();
  const files = process.argv.slice(2);
  if (!files.length) {
    console.error('usage: node conflicts.js <stored report files>');
    process.exit(2);
  }
  const totals = new Map();
  for (const file of files) {
    const log = fs.readFileSync(file, 'utf8');
    const mods = parseMods(log);
    const { known, suspects } = detect(log, mods, rules);
    const label = path.basename(file);
    for (const k of known) {
      console.log(label + '  KNOWN    ' + k.rule.name + ' ' + k.mod.version);
      totals.set(k.rule.name, (totals.get(k.rule.name) || 0) + 1);
    }
    for (const s of suspects) console.log(label + '  suspect  ' + s.mod.name + ' ' + s.mod.version + ': ' + s.why.join('; '));
    if (!known.length && !suspects.length) console.log(label + '  -');
  }
  console.log('\nKnown mods matched: ' + [...totals].map(([n, c]) => n + ' ×' + c).join(', '));
}

module.exports = { loadRules, parseMods, detect, evidence, labelFor, knownComment, suspectComment, ownErrors, harmlessOnly,
  listMessage, newMessage, discordSend, discordEdit, versionBroken, findMod };
