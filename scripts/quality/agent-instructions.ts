/**
 * Model of which instruction files each agent harness loads, and when.
 *
 * Claude Code (verified against https://code.claude.com/docs/en/memory and by the
 * InstructionsLoaded hook log, see .claude/hooks/log-instructions-loaded.sh):
 *   - Launch: root CLAUDE.md plus every root `.claude/rules/**.md` WITHOUT `paths` frontmatter.
 *   - Root rule WITH `paths`: loads when a matching file is read, written or edited.
 *   - Nested `<dir>/.claude/rules/*.md` WITHOUT `paths`: all load together the first time
 *     a file under `<dir>` is accessed.
 *   - Nested rule WITH `paths`: globs are relative to `<dir>`, not to the repository root.
 *
 * Codex (https://developers.openai.com/codex/guides/agents-md): started at the repository
 * root it loads one instruction file for that directory (AGENTS.md here) up to
 * `project_doc_max_bytes` (32 KiB by default). Nothing nested loads by itself.
 *
 * Everything here is pure so it can be unit tested without a repository checkout.
 */
import { parse as parseYaml } from 'yaml';

export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;
export const RULES_DIR_SEGMENT = '.claude/rules/';

export interface RuleFile {
  /** Repository-relative path of the rule file. */
  path: string;
  /** Directory that contains the rule's `.claude` folder; '' for the repository root. */
  baseDir: string;
  /** `paths` frontmatter patterns, or null when the rule is unconditional. */
  paths: string[] | null;
  title: string;
  bytes: number;
  body: string;
}

export interface Finding {
  check: string;
  file: string;
  message: string;
}

/** Split leading YAML frontmatter from a markdown document. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) return { data: {}, body: text };
  let data: unknown;
  try {
    data = parseYaml(match[1]);
  } catch {
    // Claude Code ignores unparseable frontmatter and loads the rule unconditionally.
    return { data: {}, body: text.slice(match[0].length) };
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { data: record, body: text.slice(match[0].length) };
}

function normalizePaths(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const patterns = list.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
  return patterns.length > 0 ? patterns : null;
}

export function parseRuleFile(path: string, text: string): RuleFile {
  const index = path.indexOf(RULES_DIR_SEGMENT);
  if (index < 0) throw new Error(`Not a rule file: ${path}`);
  const baseDir = path.slice(0, index).replace(/\/$/, '');
  const { data, body } = splitFrontmatter(text);
  const title = /^#\s+(.+)$/m.exec(body)?.[1].trim() ?? path;
  return {
    path,
    baseDir,
    paths: normalizePaths(data.paths),
    title,
    bytes: Buffer.byteLength(text, 'utf8'),
    body,
  };
}

/**
 * The glob subset rules may use. It is deliberately small: these forms mean the same
 * thing in every glob dialect, so the model cannot drift from the harness.
 * Returns a reason when the pattern is outside the subset.
 */
export function unsupportedPatternReason(pattern: string): string | null {
  if (pattern.startsWith('/')) return 'must not start with "/"';
  if (pattern.startsWith('!')) return 'negation is not supported';
  if (pattern.startsWith('./') || pattern.includes('../')) return 'must not use "./" or "../"';
  if (/[[\]{}?\\]/.test(pattern)) return 'only "*" and "**" wildcards are supported';
  if (!pattern.includes('/') && pattern.includes('*')) {
    return 'a wildcard pattern without "/" matches at any depth; write "**/name" to say so';
  }
  if (/\*\*[^/]|[^/]\*\*/.test(pattern)) return '"**" must be a whole path segment';
  return null;
}

/** Compile a supported pattern. `dir/**` also matches everything below `dir`. */
export function compilePattern(pattern: string): RegExp {
  // A bare file name matches that name at any depth, as in .gitignore.
  const anchored = pattern.includes('/') ? pattern : `**/${pattern}`;
  const segments = anchored.replace(/\/$/, '').split('/');
  let source = '';
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === '**') {
      source += last ? '.*' : '(?:[^/]+/)*';
      return;
    }
    const escaped = segment
      .split('*')
      .map((part) => part.replace(/[.+^$()|]/g, '\\$&'))
      .join('[^/]*');
    source += last ? escaped : `${escaped}/`;
  });
  // A pattern naming a directory covers the files inside it.
  return new RegExp(`^${source}(?:/.*)?$`);
}

function relativeTo(baseDir: string, file: string): string | null {
  if (baseDir === '') return file;
  return file.startsWith(`${baseDir}/`) ? file.slice(baseDir.length + 1) : null;
}

export class InstructionModel {
  private readonly compiled = new Map<string, RegExp[]>();

  constructor(
    readonly rules: RuleFile[],
    readonly rootDocs: { claude: string | null; agents: string | null }
  ) {
    for (const rule of rules) {
      if (rule.paths) {
        this.compiled.set(
          rule.path,
          rule.paths.filter((p) => !unsupportedPatternReason(p)).map(compilePattern)
        );
      }
    }
  }

  /** Rule files Claude Code loads at session start (CLAUDE.md is counted separately). */
  claudeLaunchRules(): RuleFile[] {
    return this.rules.filter((rule) => rule.baseDir === '' && rule.paths === null);
  }

  /** Whether accessing `file` loads `rule` lazily. Launch rules return false. */
  loadsOnAccess(rule: RuleFile, file: string): boolean {
    const relative = relativeTo(rule.baseDir, file);
    if (relative === null) return false;
    if (rule.paths === null) return rule.baseDir !== '';
    return (this.compiled.get(rule.path) ?? []).some((regex) => regex.test(relative));
  }

  /** Every rule that is in context once `file` has been accessed, excluding launch rules. */
  lazyRulesFor(file: string): RuleFile[] {
    return this.rules.filter((rule) => this.loadsOnAccess(rule, file));
  }

  /** Unconditional nested rules: the batch that loads on the first access under `dir`. */
  firstAccessBatches(): Map<string, RuleFile[]> {
    const batches = new Map<string, RuleFile[]>();
    for (const rule of this.rules) {
      if (rule.baseDir === '' || rule.paths !== null) continue;
      batches.set(rule.baseDir, [...(batches.get(rule.baseDir) ?? []), rule]);
    }
    return batches;
  }
}

export function sumBytes(rules: RuleFile[]): number {
  return rules.reduce((total, rule) => total + rule.bytes, 0);
}

/**
 * Source paths a rule names in backticks (implementation, tests, incident sites).
 * Markdown targets are skipped: they are references to other documents, not code
 * the rule governs.
 */
export function citedSourcePaths(
  body: string,
  exists: (path: string) => 'file' | 'dir' | null
): { path: string; kind: 'file' | 'dir' }[] {
  const found = new Map<string, 'file' | 'dir'>();
  for (const match of body.matchAll(/`([^`\s]+)`/g)) {
    const candidate = match[1]
      .split(':')[0]
      .replace(/\(\)$/, '')
      .replace(/[.,;]+$/, '')
      .replace(/\/$/, '');
    if (!/^(apps|packages|scripts|\.github)\//.test(candidate)) continue;
    if (candidate.endsWith('.md') || candidate.includes('*')) continue;
    const kind = exists(candidate);
    if (kind) found.set(candidate, kind);
  }
  return [...found.entries()]
    .map(([path, kind]) => ({ path, kind }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export interface StaticCheckInput {
  model: InstructionModel;
  trackedFiles: string[];
}

/** A rule's globs must be in the supported subset and must match at least one tracked file. */
export function checkPatterns({ model, trackedFiles }: StaticCheckInput): Finding[] {
  const findings: Finding[] = [];
  for (const rule of model.rules) {
    if (!rule.paths) continue;
    for (const pattern of rule.paths) {
      const reason = unsupportedPatternReason(pattern);
      if (reason) {
        findings.push({
          check: 'pattern-syntax',
          file: rule.path,
          message: `"${pattern}": ${reason}`,
        });
        continue;
      }
      const regex = compilePattern(pattern);
      const prefix = rule.baseDir === '' ? '' : `${rule.baseDir}/`;
      const matches = trackedFiles.some(
        (file) => file.startsWith(prefix) && regex.test(file.slice(prefix.length))
      );
      if (!matches) {
        const where = rule.baseDir === '' ? 'the repository root' : `${rule.baseDir}/`;
        findings.push({
          check: 'dead-pattern',
          file: rule.path,
          message: `"${pattern}" matches no tracked file (patterns are relative to ${where}), so it can never load this rule`,
        });
      }
    }
  }
  return findings;
}

/**
 * A rule that names source files must load when those files are accessed. This is what
 * catches a rule left behind when the code it governs moves to another package.
 */
export function checkCitationsCovered({ model, trackedFiles }: StaticCheckInput): Finding[] {
  const fileSet = new Set(trackedFiles);
  const dirSet = new Set<string>();
  for (const file of trackedFiles) {
    let dir = file;
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      if (dirSet.has(dir)) break;
      dirSet.add(dir);
    }
  }
  const exists = (path: string) => (fileSet.has(path) ? 'file' : dirSet.has(path) ? 'dir' : null);
  const launch = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  const findings: Finding[] = [];
  for (const rule of model.rules) {
    if (launch.has(rule.path)) continue;
    for (const cited of citedSourcePaths(rule.body, exists)) {
      const covered =
        cited.kind === 'file'
          ? model.loadsOnAccess(rule, cited.path)
          : trackedFiles.some(
              (file) => file.startsWith(`${cited.path}/`) && model.loadsOnAccess(rule, file)
            );
      if (!covered) {
        findings.push({
          check: 'citation-not-covered',
          file: rule.path,
          message: `names ${cited.path} but does not load when that ${cited.kind === 'file' ? 'file' : 'directory'} is accessed`,
        });
      }
    }
  }
  return findings;
}

/** Byte-identical rule files are copies that will drift; keep one and scope it with `paths`. */
export function checkNoDuplicateBodies(rules: RuleFile[]): Finding[] {
  const byBody = new Map<string, RuleFile[]>();
  for (const rule of rules) {
    const key = rule.body.trim();
    byBody.set(key, [...(byBody.get(key) ?? []), rule]);
  }
  const findings: Finding[] = [];
  for (const group of byBody.values()) {
    if (group.length < 2) continue;
    const [first, ...rest] = group.map((rule) => rule.path).sort();
    for (const copy of rest) {
      findings.push({ check: 'duplicate-rule', file: copy, message: `is a copy of ${first}` });
    }
  }
  return findings;
}

export interface HookEntryProblem {
  event: string;
  message: string;
}

/**
 * Claude Code silently ignores a malformed hook entry, so a hook can look configured
 * and never run. Each event holds matcher groups; each group holds a `hooks` array.
 */
export function checkClaudeHookConfig(settings: unknown): HookEntryProblem[] {
  const problems: HookEntryProblem[] = [];
  const hooks = (settings as { hooks?: unknown } | null)?.hooks;
  if (hooks === undefined) return problems;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return [{ event: '(root)', message: '"hooks" must be an object keyed by event name' }];
  }
  for (const [event, groups] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(groups)) {
      problems.push({ event, message: 'must be an array of matcher groups' });
      continue;
    }
    groups.forEach((group, index) => {
      const handlers = (group as { hooks?: unknown } | null)?.hooks;
      if (!Array.isArray(handlers) || handlers.length === 0) {
        problems.push({
          event,
          message: `entry ${index} has no "hooks" array; Claude Code ignores it and the hook never runs`,
        });
        return;
      }
      handlers.forEach((handler, handlerIndex) => {
        const typed = handler as { type?: unknown; command?: unknown; timeout?: unknown } | null;
        if (typed?.type === 'command' && typeof typed.command !== 'string') {
          problems.push({
            event,
            message: `entry ${index} handler ${handlerIndex} has no command`,
          });
        }
        if (typeof typed?.timeout === 'number' && typed.timeout > 3600) {
          problems.push({
            event,
            message: `entry ${index} handler ${handlerIndex} timeout ${typed.timeout} is in seconds, not milliseconds`,
          });
        }
      });
    });
  }
  return problems;
}
