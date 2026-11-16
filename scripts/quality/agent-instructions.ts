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

const byText = (a: string, b: string) => a.localeCompare(b);

/** Split leading YAML frontmatter (between two `---` lines) from a markdown document. */
export function splitFrontmatter(text: string): { data: Record<string, unknown>; body: string } {
  const normalized = text.replaceAll('\r\n', '\n');
  if (!normalized.startsWith('---\n')) return { data: {}, body: text };
  const end = normalized.indexOf('\n---\n', 3);
  if (end < 0) return { data: {}, body: text };
  const body = normalized.slice(end + '\n---\n'.length);
  let data: unknown;
  try {
    data = parseYaml(normalized.slice(4, end));
  } catch {
    // Claude Code ignores unparseable frontmatter and loads the rule unconditionally.
    return { data: {}, body };
  }
  const record = data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  return { data: record, body };
}

function normalizePaths(value: unknown): string[] | null {
  let entries: unknown[] = [];
  if (Array.isArray(value)) entries = value;
  else if (typeof value === 'string') entries = value.split(',');
  const patterns = entries
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return patterns.length > 0 ? patterns : null;
}

function firstHeading(body: string): string | null {
  for (const line of body.split('\n')) {
    if (line.startsWith('# ')) return line.slice(2).trim();
  }
  return null;
}

export function parseRuleFile(path: string, text: string): RuleFile {
  const index = path.indexOf(RULES_DIR_SEGMENT);
  if (index < 0) throw new Error(`Not a rule file: ${path}`);
  const baseDir = index === 0 ? '' : path.slice(0, index - 1);
  const { data, body } = splitFrontmatter(text);
  return {
    path,
    baseDir,
    paths: normalizePaths(data.paths),
    title: firstHeading(body) ?? path,
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
  const misplaced = pattern
    .split('/')
    .some((segment) => segment.includes('**') && segment !== '**');
  return misplaced ? '"**" must be a whole path segment' : null;
}

function segmentSource(segment: string): string {
  return segment
    .split('*')
    .map((part) => part.replaceAll(/[.+^$()|]/g, String.raw`\$&`))
    .join('[^/]*');
}

/** Compile a supported pattern. A pattern that names a directory covers its files. */
export function compilePattern(pattern: string): RegExp {
  // A bare file name matches that name at any depth, as in .gitignore.
  const anchored = pattern.includes('/') ? pattern : `**/${pattern}`;
  const trimmed = anchored.endsWith('/') ? anchored.slice(0, -1) : anchored;
  const segments = trimmed.split('/');
  const lastIndex = segments.length - 1;
  const source = segments
    .map((segment, index) => {
      if (segment === '**') return index === lastIndex ? '.*' : '(?:[^/]+/)*';
      return index === lastIndex ? segmentSource(segment) : `${segmentSource(segment)}/`;
    })
    .join('');
  // A final segment with a wildcard names files (`src/components/*.tsx`), so it must not
  // match deeper paths; one without a wildcard may be a directory.
  const namesDirectory = !segments[lastIndex].includes('*');
  return new RegExp(`^${source}${namesDirectory ? '(?:/.*)?' : ''}$`);
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

const CITABLE_ROOTS = ['apps/', 'packages/', 'scripts/', '.github/'];
const TRAILING_PUNCTUATION = new Set(['.', ',', ';', '/']);

/** `apps/api/src/x.ts:12` or `pkg/file.go()` reduced to the path it names. */
function citedPath(token: string): string {
  let path = token.split(':')[0];
  if (path.endsWith('()')) path = path.slice(0, -2);
  while (path.length > 0 && TRAILING_PUNCTUATION.has(path[path.length - 1])) {
    path = path.slice(0, -1);
  }
  return path;
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
  // Backtick spans are the odd-numbered pieces of the text split on backticks.
  const pieces = body.split('`');
  for (let index = 1; index < pieces.length; index += 2) {
    const token = pieces[index];
    if (token.includes(' ') || token.includes('\n')) continue;
    const candidate = citedPath(token);
    if (!CITABLE_ROOTS.some((root) => candidate.startsWith(root))) continue;
    if (candidate.endsWith('.md') || candidate.includes('*')) continue;
    const kind = exists(candidate);
    if (kind) found.set(candidate, kind);
  }
  return [...found.entries()]
    .map(([path, kind]) => ({ path, kind }))
    .sort((a, b) => byText(a.path, b.path));
}

export interface StaticCheckInput {
  model: InstructionModel;
  trackedFiles: string[];
}

function patternFinding(rule: RuleFile, pattern: string, trackedFiles: string[]): Finding | null {
  const reason = unsupportedPatternReason(pattern);
  if (reason) {
    return { check: 'pattern-syntax', file: rule.path, message: `"${pattern}": ${reason}` };
  }
  const regex = compilePattern(pattern);
  const prefix = rule.baseDir === '' ? '' : `${rule.baseDir}/`;
  const matches = trackedFiles.some(
    (file) => file.startsWith(prefix) && regex.test(file.slice(prefix.length))
  );
  if (matches) return null;
  const where = rule.baseDir === '' ? 'the repository root' : `${rule.baseDir}/`;
  return {
    check: 'dead-pattern',
    file: rule.path,
    message: `"${pattern}" matches no tracked file (patterns are relative to ${where}), so it can never load this rule`,
  };
}

/** A rule's globs must be in the supported subset and must match at least one tracked file. */
export function checkPatterns({ model, trackedFiles }: StaticCheckInput): Finding[] {
  return model.rules.flatMap((rule) =>
    (rule.paths ?? [])
      .map((pattern) => patternFinding(rule, pattern, trackedFiles))
      .filter((finding): finding is Finding => finding !== null)
  );
}

function pathIndex(trackedFiles: string[]): (path: string) => 'file' | 'dir' | null {
  const files = new Set(trackedFiles);
  const dirs = new Set<string>();
  for (const file of trackedFiles) {
    let dir = file;
    while (dir.includes('/')) {
      dir = dir.slice(0, dir.lastIndexOf('/'));
      if (dirs.has(dir)) break;
      dirs.add(dir);
    }
  }
  return (path) => {
    if (files.has(path)) return 'file';
    return dirs.has(path) ? 'dir' : null;
  };
}

/**
 * A rule that names source files must load when those files are accessed. This is what
 * catches a rule left behind when the code it governs moves to another package.
 * A named directory counts as covered when the rule loads for at least one file in it.
 */
export function checkCitationsCovered({ model, trackedFiles }: StaticCheckInput): Finding[] {
  const exists = pathIndex(trackedFiles);
  const launch = new Set(model.claudeLaunchRules().map((rule) => rule.path));
  const covers = (rule: RuleFile, cited: { path: string; kind: 'file' | 'dir' }) =>
    cited.kind === 'file'
      ? model.loadsOnAccess(rule, cited.path)
      : trackedFiles.some(
          (file) => file.startsWith(`${cited.path}/`) && model.loadsOnAccess(rule, file)
        );
  return model.rules
    .filter((rule) => !launch.has(rule.path))
    .flatMap((rule) =>
      citedSourcePaths(rule.body, exists)
        .filter((cited) => !covers(rule, cited))
        .map((cited) => ({
          check: 'citation-not-covered',
          file: rule.path,
          message: `names ${cited.path} but does not load when that ${cited.kind === 'file' ? 'file' : 'directory'} is accessed`,
        }))
    );
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
    const [first, ...rest] = group.map((rule) => rule.path).sort(byText);
    for (const copy of rest) {
      findings.push({ check: 'duplicate-rule', file: copy, message: `is a copy of ${first}` });
    }
  }
  return findings;
}
