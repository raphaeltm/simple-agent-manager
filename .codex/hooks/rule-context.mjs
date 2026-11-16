#!/usr/bin/env node
// rule-context.mjs — Codex hook that delivers path-scoped rules.
//
// Codex started at the repository root loads only the root AGENTS.md. Claude Code loads a
// path-scoped rule (.claude/rules/*.md with `paths` frontmatter) when a matching file is
// accessed; this hook gives Codex the same rules at the same moment:
//
//   SessionStart (startup, resume, clear, compact, fork)
//       Starts a new delivery epoch when the model's context was reset (startup, clear,
//       compact), so rules are delivered again, and tells the model how delivery works.
//   PreToolUse (apply_patch, Bash)
//       Finds the repository paths the call touches, and adds the bodies of the rules
//       that govern them and have not been delivered in this epoch as additionalContext.
//       The first write to paths whose rules were never delivered is denied once, so the
//       rules are in context before anything is written; the retried write is allowed.
//
// Which rules apply to a path comes from .codex/hooks/rule-scopes.json, generated from
// scripts/quality/agent-instructions.ts by `pnpm quality:agent-context-budget --write`
// (--check fails when it is stale). Rule bodies are read from disk when delivered.
//
// Constraints: Node built-ins only (it must run in a workspace without node_modules); it
// never fails a session (every error path prints `{}` and exits 0, which Codex treats as
// "no opinion"); output is bounded by SAM_CODEX_RULE_CONTEXT_MAX_BYTES so Codex never
// spills it to disk. Every delivery is logged to .tmp/instruction-loads/codex-<session>.jsonl.
//
// `node .codex/hooks/rule-context.mjs --show <path>...` prints the rules for paths, for an
// agent (or a person) who wants them without a hook.

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const LOOKUP_FILE = join(ROOT, '.codex/hooks/rule-scopes.json');
const STATE_DIR = join(ROOT, '.tmp/codex-rule-context');
const LOG_DIR = join(ROOT, '.tmp/instruction-loads');

/**
 * Rule text per hook output. Must stay below the handler's additionalContextLimit in
 * .codex/config.toml (16000 tokens, roughly 56 KB of rule prose) so Codex never spills.
 */
const DEFAULT_MAX_BYTES = 40_000;
const MIN_MAX_BYTES = 4_000;
const MAX_MAX_BYTES = 48_000;

/** Session-start sources after which the model no longer has earlier hook context. */
const RESET_SOURCES = new Set(['startup', 'clear', 'compact']);

/** Shell words that write their path arguments. */
const SHELL_WRITERS = new Set([
  'cp',
  'install',
  'ln',
  'mkdir',
  'mv',
  'rm',
  'rmdir',
  'tee',
  'touch',
  'truncate',
]);

const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', '.tmp', 'dist']);

export function maxBytes(env = process.env) {
  const raw = Number.parseInt(env.SAM_CODEX_RULE_CONTEXT_MAX_BYTES ?? '', 10);
  if (!Number.isFinite(raw)) return DEFAULT_MAX_BYTES;
  return Math.min(MAX_MAX_BYTES, Math.max(MIN_MAX_BYTES, raw));
}

export function loadLookup(file = LOOKUP_FILE) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (!data || !Array.isArray(data.rules)) throw new Error('rule-scopes.json has no rules array');
  return data.rules.map((rule) => ({
    path: String(rule.path),
    title: String(rule.title),
    patterns: rule.patterns.map((p) => ({ literal: p.literal, regex: new RegExp(p.regex) })),
  }));
}

/** How narrowly a matched pattern names the path: its literal characters. */
function specificity(rule, path) {
  let best = -1;
  for (const pattern of rule.patterns) {
    if (pattern.regex.test(path)) best = Math.max(best, pattern.literal);
  }
  return best;
}

/** Rules governing any of `paths`, most specific first; a directory matches its contents. */
export function rulesFor(lookup, paths) {
  const scored = new Map();
  for (const path of paths) {
    const probes = path.isDirectory ? [`${path.path}/x`] : [path.path];
    for (const probe of probes) {
      for (const rule of lookup) {
        const score = specificity(rule, probe);
        if (score < 0) continue;
        const entry = scored.get(rule.path);
        if (!entry || entry.score < score) scored.set(rule.path, { rule, score });
      }
    }
  }
  return [...scored.values()]
    .sort((a, b) => b.score - a.score || a.rule.path.localeCompare(b.rule.path))
    .map((entry) => entry.rule);
}

/** Repository-relative path for a token, or null when it is outside the repository. */
export function toRepoPath(token, cwd, root = ROOT) {
  const absolute = isAbsolute(token) ? token : resolve(cwd, token);
  const rel = relative(root, absolute);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  const normalized = rel.split('\\').join('/');
  if (normalized.split('/').some((segment) => IGNORED_SEGMENTS.has(segment))) return null;
  return normalized;
}

/** Target paths of an apply_patch body. */
export function patchPaths(patch) {
  const paths = [];
  for (const line of String(patch).split('\n')) {
    const match = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line.trim());
    if (match) paths.push(match[1].trim());
  }
  return paths;
}

function shellWords(command) {
  // Good enough to find path arguments; not a shell parser. Quotes are stripped, operators
  // split words, and anything with expansion syntax is dropped.
  return String(command)
    .replaceAll(/\\\n/g, ' ')
    .split(/[\s;|&()<>]+/)
    .map((word) => word.replaceAll(/^['"]+|['"]+$/g, ''))
    .filter((word) => word.length > 0);
}

/**
 * Paths a shell command reads or writes, resolved against `cd` steps inside it. A command
 * counts as a write when it redirects output, edits in place, or runs a writing command.
 */
export function shellPaths(command, cwd, root = ROOT, exists = defaultExists) {
  const text = String(command);
  const words = shellWords(text);
  let base = cwd;
  const found = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index];
    if (word === 'cd' && words[index + 1]) {
      const next = words[index + 1];
      if (!/[$`*]/.test(next)) base = resolve(base, next);
      index++;
      continue;
    }
    const candidate = word.includes('=') && word.startsWith('-') ? word.split('=')[1] : word;
    if (!candidate || candidate.startsWith('-') || /[$`*?{}[\]]/.test(candidate)) continue;
    if (!candidate.includes('/') && !candidate.includes('.')) continue;
    const absolute = isAbsolute(candidate) ? candidate : resolve(base, candidate);
    const repoPath = toRepoPath(absolute, base, root);
    if (!repoPath) continue;
    const kind = exists(absolute);
    if (kind) found.push({ path: repoPath, isDirectory: kind === 'dir', exists: true });
    else if (exists(dirname(absolute)) === 'dir') {
      found.push({ path: repoPath, isDirectory: false, exists: false });
    }
  }
  const writes =
    />>?\s*[^\s&|]/.test(text.replaceAll(/[0-9]?>&[0-9]/g, '').replaceAll(/>\s*\/dev\/null/g, '')) ||
    /\b(?:sed|perl)\s+(?:-[a-zA-Z]*\s+)*-[a-zA-Z]*i/.test(text) ||
    /\bgit\s+(?:mv|rm|apply|checkout|restore)\b/.test(text) ||
    words.some((word) => SHELL_WRITERS.has(word));
  return { paths: dedupe(found), writes };
}

function dedupe(paths) {
  const seen = new Map();
  for (const entry of paths) if (!seen.has(entry.path)) seen.set(entry.path, entry);
  return [...seen.values()];
}

function defaultExists(path) {
  try {
    return statSync(path).isDirectory() ? 'dir' : 'file';
  } catch {
    return null;
  }
}

function readRuleBody(rulePath, root) {
  const text = readFileSync(join(root, rulePath), 'utf8');
  // Drop the frontmatter: the scope is stated in the header line instead.
  return text.replace(/^---\n[\s\S]*?\n---\n/, '').trim();
}

/**
 * Build the model-visible text for `rules`, delivering whole bodies in order until the
 * byte budget is spent, and naming the rest so the model knows they exist (a capped
 * selection must disclose what it dropped).
 */
export function renderDelivery(rules, targets, budget, root = ROOT) {
  const header = [
    `SAM rule delivery (.codex/hooks/rule-context.mjs). These repository rules govern ${targets
      .slice(0, 5)
      .join(', ')}${targets.length > 5 ? `, +${targets.length - 5} more` : ''}.`,
    'Claude Code loads them by itself when these files are accessed; treat them as project instructions for this work.',
  ].join('\n');
  const parts = [header];
  let used = Buffer.byteLength(header);
  const delivered = [];
  const deferred = [];
  for (const rule of rules) {
    let body;
    try {
      body = readRuleBody(rule.path, root);
    } catch {
      continue;
    }
    const block = `\n\n===== ${rule.path} =====\n${body}`;
    const size = Buffer.byteLength(block);
    if (used + size > budget - 1500) {
      deferred.push(rule);
      continue;
    }
    parts.push(block);
    used += size;
    delivered.push({ rule, bytes: size });
  }
  if (deferred.length > 0) {
    const lines = deferred
      .slice(0, 40)
      .map((rule) => `- ${rule.path}: ${rule.title}`)
      .join('\n');
    const more = deferred.length > 40 ? `\n- +${deferred.length - 40} more` : '';
    parts.push(
      `\n\nAlso governing these paths, not delivered yet because of the per-call size cap. They arrive with your next tool calls on these paths, or run \`node .codex/hooks/rule-context.mjs --show ${targets[0] ?? '<path>'}\`:\n${lines}${more}`
    );
  }
  return { text: parts.join(''), delivered, deferred };
}

function sessionKey(sessionId) {
  return String(sessionId || 'unknown').replaceAll(/[^A-Za-z0-9._-]/g, '_');
}

function readState(sessionId) {
  try {
    const state = JSON.parse(readFileSync(join(STATE_DIR, `${sessionKey(sessionId)}.json`), 'utf8'));
    return {
      epoch: Number(state.epoch) || 0,
      delivered: Array.isArray(state.delivered) ? state.delivered : [],
      deniedWrites: Array.isArray(state.deniedWrites) ? state.deniedWrites : [],
    };
  } catch {
    return { epoch: 0, delivered: [], deniedWrites: [] };
  }
}

function writeState(sessionId, state) {
  mkdirSync(STATE_DIR, { recursive: true });
  const file = join(STATE_DIR, `${sessionKey(sessionId)}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(state));
  renameSync(temporary, file);
}

function log(sessionId, entries) {
  if (entries.length === 0) return;
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    const at = new Date().toISOString();
    const lines = entries.map((entry) => JSON.stringify({ at, harness: 'codex', session_id: sessionId, ...entry }));
    appendFileSync(join(LOG_DIR, `codex-${sessionKey(sessionId)}.jsonl`), `${lines.join('\n')}\n`);
  } catch {
    // Logging must never fail the hook.
  }
}

function sessionStart(event) {
  const source = String(event.source ?? 'startup');
  const state = readState(event.session_id);
  let epoch = state.epoch;
  if (RESET_SOURCES.has(source) || epoch === 0) {
    epoch += 1;
    writeState(event.session_id, { epoch, delivered: [], deniedWrites: [] });
  }
  log(event.session_id, [{ event: 'SessionStart', source, load_reason: 'session_start', epoch }]);
  return {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext:
        'SAM rule delivery is active. Before a tool call that reads or writes repository files, a hook adds the path-scoped rules (.claude/rules/*.md) that govern those files, if they are not already in your context. The first write to files whose rules you have not seen is refused once with the rules attached: read them, adjust if needed, and retry. The rules every task follows are listed in AGENTS.md under "Rules"; open the ones that bear on your task.',
    },
  };
}

function preToolUse(event, lookup, budget) {
  const tool = String(event.tool_name ?? '');
  const command = event.tool_input?.command ?? '';
  const cwd = typeof event.cwd === 'string' && event.cwd ? event.cwd : ROOT;
  let targets;
  let writes;
  if (tool === 'apply_patch') {
    targets = patchPaths(command)
      .map((path) => toRepoPath(path, cwd))
      .filter(Boolean)
      .map((path) => ({ path, isDirectory: false }));
    writes = true;
  } else if (tool === 'Bash') {
    ({ paths: targets, writes } = shellPaths(command, cwd));
  } else {
    return {};
  }
  if (targets.length === 0) return {};
  const state = readState(event.session_id);
  const delivered = new Set(state.delivered);
  const pending = rulesFor(lookup, targets).filter((rule) => !delivered.has(rule.path));
  if (pending.length === 0) return {};

  const targetPaths = targets.map((target) => target.path);
  const rendered = renderDelivery(pending, targetPaths, budget);
  if (rendered.delivered.length === 0 && rendered.deferred.length === 0) return {};
  const writeKey = createHash('sha256').update(targetPaths.slice().sort().join('\n')).digest('hex').slice(0, 16);
  // Deny only to deliver: a write is refused once, and only when rule text came with it.
  const deny = writes && rendered.delivered.length > 0 && !state.deniedWrites.includes(writeKey);
  writeState(event.session_id, {
    epoch: state.epoch,
    delivered: [...delivered, ...rendered.delivered.map((entry) => entry.rule.path)],
    deniedWrites: deny ? [...state.deniedWrites, writeKey] : state.deniedWrites,
  });
  log(
    event.session_id,
    rendered.delivered.map((entry) => ({
      event: 'PreToolUse',
      tool,
      load_reason: 'path_match',
      file: entry.rule.path,
      trigger: targetPaths[0],
      triggers: targetPaths.slice(0, 10),
      bytes: entry.bytes,
      decision: deny ? 'deny_once' : 'allow',
      epoch: state.epoch,
      tool_use_id: event.tool_use_id ?? null,
    }))
  );
  const output = {
    hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: rendered.text },
  };
  if (deny) {
    output.hookSpecificOutput.permissionDecision = 'deny';
    output.hookSpecificOutput.permissionDecisionReason = `Not run yet: ${rendered.delivered.length} repository rule(s) governing ${targetPaths[0]} were not in your context. They are attached as context. Check this change against them, then run it again (the retry is allowed). If you cannot see the rule text, run: node .codex/hooks/rule-context.mjs --show ${targetPaths[0]}`;
  }
  return output;
}

function show(paths) {
  const lookup = loadLookup();
  const targets = paths
    .map((path) => toRepoPath(path, process.cwd()))
    .filter(Boolean)
    .map((path) => ({ path, isDirectory: defaultExists(join(ROOT, path)) === 'dir' }));
  const rules = rulesFor(lookup, targets);
  if (rules.length === 0) {
    process.stdout.write('No path-scoped rules govern these paths.\n');
    return;
  }
  process.stdout.write(`${renderDelivery(rules, targets.map((t) => t.path), maxBytes()).text}\n`);
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--show') {
    show(args.slice(1));
    return;
  }
  let output = {};
  let event = {};
  try {
    event = JSON.parse(readFileSync(0, 'utf8') || '{}');
    if (event.hook_event_name === 'SessionStart') output = sessionStart(event);
    else if (event.hook_event_name === 'PreToolUse') {
      output = preToolUse(event, loadLookup(), maxBytes());
    }
  } catch (error) {
    output = {};
    log(event.session_id, [
      { event: String(event.hook_event_name ?? 'unknown'), load_reason: 'error', error: String(error?.message ?? error).slice(0, 300) },
    ]);
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch {
    process.stdout.write('{}\n');
  }
  process.exitCode = 0;
}
