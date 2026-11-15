/**
 * Which inputs decide a container image's contents, read from its Dockerfile.
 *
 * A deploy reuses an image already in the account registry only when every input
 * that can change the image is accounted for (`container-image-reuse.ts`). Files
 * copied from the build context are hashed. Anything installed from a network
 * source without a pinned digest (apt packages, transitive npm and PyPI
 * dependencies, a fetched script) is a floating input: its fingerprint must
 * change whenever the upstream source can produce different bytes
 * (`container-image-fingerprints.ts`). A Dockerfile shape this module does not
 * recognise yields no inputs at all, and the deploy builds the image as before.
 * Doubt leads to a rebuild, never to reuse (.claude/rules/74, requirement 5).
 */
import { createHash } from 'node:crypto';

import { BASE_IMAGE_APT_SOURCES, REVIEWED_BUILD_SCRIPTS } from './container-image-reviewed-inputs';

/** One apt suite an image stage installs from. */
export interface AptSource {
  url: string;
  suite: string;
  components: string[];
}

/** `uv tool install <spec> --with <pin>... --python <version>`. */
export interface PypiTool {
  spec: string;
  with: string[];
  python: string;
}

export interface ImageInputs {
  /** Base image references, each pinned by digest. */
  bases: string[];
  /** Build-context paths copied into the image. */
  copies: string[];
  apt: AptSource[];
  /** URLs fetched by `RUN`; their bytes are inputs. */
  urls: string[];
  /** Exact `name@version` specs installed with `npm install -g`, one global tree each. */
  npm: string[];
  pypi: PypiTool[];
  /** Copied build-context files executed during the build (reviewed list). */
  scripts: string[];
}

export type DockerfileAnalysis = { ok: true; inputs: ImageInputs } | { ok: false; reason: string };

const DIGEST_REF = /@(sha256:[a-f0-9]{64})$/;
const CONTEXT_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const NPM_EXACT =
  /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PYPI_EXACT = /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][0-9A-Za-z.+!-]*$/;
const URL_LITERAL = /https?:\/\/[^\s"'`)]+/g;
const DEB_LINE =
  /\bdeb\s+(?:\[[^\]]*\]\s+)?(https?:\/\/[^\s"']+)\s+([^\s"'>]+)((?:\s+[A-Za-z0-9][A-Za-z0-9-]*)+)/g;
/** Installers whose resolution this module cannot fingerprint. */
const UNSUPPORTED_COMMANDS = new Set([
  'add-apt-repository',
  'apk',
  'bun',
  'cargo',
  'conda',
  'dnf',
  'gem',
  'git',
  'go',
  'npx',
  'pip',
  'pip3',
  'pipx',
  'pnpm',
  'snap',
  'uvx',
  'yarn',
  'yum',
]);
const INTERPRETERS = new Set(['sh', 'bash', 'python', 'python3', 'node']);
const ALLOWED_INSTRUCTIONS = new Set([
  'FROM',
  'COPY',
  'RUN',
  'ENV',
  'LABEL',
  'USER',
  'WORKDIR',
  'ENTRYPOINT',
  'CMD',
  'EXPOSE',
]);

class Unsupported extends Error {}
function unsupported(reason: string): never {
  throw new Unsupported(reason);
}

/** Dockerfile instructions after comment removal and line-continuation joining. */
export function dockerfileInstructions(text: string): { keyword: string; args: string }[] {
  const lines = text.split('\n');
  if (/^#\s*[A-Za-z]+\s*=/.test(lines[0] ?? ''))
    unsupported('parser directive (it can select an unpinned frontend)');
  const instructions: { keyword: string; args: string }[] = [];
  let current = '';
  for (const raw of lines) {
    // BuildKit drops comment lines, also inside a continued instruction.
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/\s+$/, '');
    if (line.endsWith('\\')) {
      // A shell line continuation is no separator: `a \\<newline> b` is `a b`.
      current += `${line.slice(0, -1)} `;
      continue;
    }
    current += line;
    const match = /^\s*([A-Za-z]+)\s+([\s\S]*)$/.exec(current);
    if (match) instructions.push({ keyword: match[1].toUpperCase(), args: match[2].trim() });
    else if (current.trim()) unsupported(`unparseable line: ${current.trim().slice(0, 80)}`);
    current = '';
  }
  if (current.trim()) unsupported('dangling line continuation');
  return instructions;
}

/**
 * Shell-ish split of a RUN body into simple commands of words. Quotes and
 * `$(...)` group words; `&&`, `||`, `;` and `|` outside them separate commands.
 * Quote characters are removed from the words. Redirections stay as words.
 */
export function shellCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let quote = '';
  let depth = 0;
  let inWord = false;
  const endWord = () => {
    if (inWord) words.push(word);
    word = '';
    inWord = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      continue;
    }
    if (depth > 0) {
      if (char === '(') depth++;
      if (char === ')') depth--;
      word += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '$' && text[index + 1] === '(') {
      word += '$(';
      depth = 1;
      inWord = true;
      index++;
    } else if (/\s/.test(char)) endWord();
    else if (char === ';') endCommand();
    else if (char === '&' && text[index + 1] === '&') {
      endCommand();
      index++;
    } else if (char === '|') {
      endCommand();
      if (text[index + 1] === '|') index++;
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote || depth) unsupported('unbalanced quote or $( in RUN');
  endCommand();
  return commands;
}

interface Stage {
  digest: string;
  apt: AptSource[];
}

interface CopyTarget {
  source: string;
  destination: string;
}

function analyzeCopy(args: string, stages: Map<string, Stage>, copies: CopyTarget[]) {
  if (args.startsWith('[') || args.includes('<<')) unsupported('COPY in JSON or heredoc form');
  const words = args.split(/\s+/);
  const flags = words.filter((word) => word.startsWith('--'));
  const paths = words.filter((word) => !word.startsWith('--'));
  for (const flag of flags) {
    const from = /^--from=(.+)$/.exec(flag);
    if (from) {
      // A --from naming an image instead of a stage would pull an unkeyed image.
      if (!stages.has(from[1].toLowerCase())) unsupported(`COPY --from=${from[1]} is not a stage`);
      return;
    }
    if (!/^--(?:chown|chmod)=/.test(flag)) unsupported(`COPY flag ${flag}`);
  }
  if (paths.length < 2) unsupported('COPY without source and destination');
  const destination = paths[paths.length - 1];
  for (const source of paths.slice(0, -1)) {
    if (!CONTEXT_PATH.test(source) || source.split('/').includes('..'))
      unsupported(`COPY source ${source} is not a plain context file path`);
    const target = destination.endsWith('/')
      ? `${destination}${source.split('/').pop()}`
      : destination;
    copies.push({ source, destination: target });
  }
}

function aptSourcesFromRun(text: string): AptSource[] {
  const sources: AptSource[] = [];
  for (const match of text.matchAll(DEB_LINE)) {
    const [, url, suite, components] = match;
    if (url.includes('$') || suite.includes('$')) unsupported('apt source with a variable');
    sources.push({
      url: url.replace(/\/$/, ''),
      suite,
      components: components.trim().split(/\s+/),
    });
  }
  return sources;
}

function commandsOf(text: string): string[][] {
  return shellCommands(text)
    .map((tokens) => {
      // Drop leading VAR=value assignments.
      let index = 0;
      while (index < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index])) index++;
      return tokens.slice(index);
    })
    .filter((tokens) => tokens.length > 0);
}

interface RunState {
  stage: Stage;
  copies: CopyTarget[];
  inputs: ImageInputs;
}

function scriptTarget(path: string | undefined, state: RunState) {
  if (path === undefined) return; // Reads stdin: the piped content is a fetched URL.
  if (path.startsWith('-')) unsupported(`interpreter flag ${path}`);
  // Files of an exact-pinned global npm package (the claude-code postinstall).
  if (/^\$\(npm root -g\)\//.test(path)) return;
  const copy = state.copies.find((candidate) => candidate.destination === path);
  if (!copy) unsupported(`build executes ${path}, which is not a copied file`);
  if (!REVIEWED_BUILD_SCRIPTS[copy.source])
    unsupported(`build executes ${copy.source}, which is not in REVIEWED_BUILD_SCRIPTS`);
  state.inputs.scripts.push(copy.source);
}

function analyzeNpm(tokens: string[], state: RunState) {
  const sub = tokens[1];
  if (sub === 'cache' || sub === 'root') return;
  if (sub !== 'install' && sub !== 'i') unsupported(`npm ${sub ?? ''}`);
  const rest = tokens.slice(2);
  if (!rest.includes('-g') && !rest.includes('--global')) unsupported('npm install without -g');
  for (const token of rest) {
    if (token.startsWith('-')) {
      if (!['-g', '--global', '--ignore-scripts', '--no-audit', '--no-fund'].includes(token))
        unsupported(`npm install flag ${token}`);
      continue;
    }
    if (!NPM_EXACT.test(token)) unsupported(`npm spec ${token} is not an exact version`);
    state.inputs.npm.push(token);
  }
}

function analyzeUv(tokens: string[], state: RunState) {
  if (tokens[1] === 'tool' && tokens[2] === 'install') {
    const tool: PypiTool = { spec: '', with: [], python: '' };
    for (let index = 3; index < tokens.length; index++) {
      const token = tokens[index];
      if (token === '--with') tool.with.push(tokens[++index] ?? '');
      else if (token === '--python') tool.python = tokens[++index] ?? '';
      else if (token === '--quiet' || token === '-q') continue;
      else if (token.startsWith('-')) unsupported(`uv tool install flag ${token}`);
      else if (tool.spec) unsupported('uv tool install with two packages');
      else tool.spec = token;
    }
    if (![tool.spec, ...tool.with].every((spec) => PYPI_EXACT.test(spec)))
      unsupported('uv tool install spec is not pinned with ==');
    if (!/^\d+\.\d+$/.test(tool.python)) unsupported('uv tool install without --python X.Y');
    state.inputs.pypi.push(tool);
    return;
  }
  if (tokens[1] === 'run') {
    let index = 2;
    while (tokens[index]?.startsWith('-')) {
      if (tokens[index] !== '--python') unsupported(`uv run flag ${tokens[index]}`);
      index += 2;
    }
    if (!INTERPRETERS.has(tokens[index] ?? '')) unsupported('uv run of a non-interpreter command');
    scriptTarget(tokens[index + 1], state);
    return;
  }
  unsupported(`uv ${tokens[1] ?? ''}`);
}

function analyzeRun(args: string, state: RunState) {
  if (args.startsWith('[') || args.startsWith('--') || args.includes('<<'))
    unsupported('RUN in exec, flagged or heredoc form');
  const debSources = aptSourcesFromRun(args);
  const withoutDeb = args.replace(DEB_LINE, ' ');
  for (const url of withoutDeb.match(URL_LITERAL) ?? []) {
    if (url.includes('$')) unsupported(`fetched URL with a variable: ${url}`);
    state.inputs.urls.push(url);
  }
  let installsApt = false;
  for (const tokens of commandsOf(args)) {
    const command = tokens[0].split('/').pop() ?? tokens[0];
    if (UNSUPPORTED_COMMANDS.has(command)) unsupported(`installer ${command} is not fingerprinted`);
    if (command === 'apt-get' || command === 'apt') installsApt ||= tokens.includes('install');
    else if (command === 'npm') analyzeNpm(tokens, state);
    else if (command === 'uv') analyzeUv(tokens, state);
    else if (command === 'curl' || command === 'wget') {
      if (!tokens.some((token) => /^https?:\/\//.test(token)))
        unsupported(`${command} without a literal URL`);
    } else if (INTERPRETERS.has(command)) scriptTarget(tokens[1], state);
  }
  state.stage.apt.push(...debSources);
  if (installsApt) {
    const base = BASE_IMAGE_APT_SOURCES[state.stage.digest];
    if (!base) unsupported(`apt-get install on unreviewed base ${state.stage.digest}`);
    state.inputs.apt.push(...base, ...state.stage.apt);
  }
}

function sortedUnique<T>(values: T[], key: (value: T) => string): T[] {
  const byKey = new Map(values.map((value) => [key(value), value]));
  return [...byKey.keys()]
    .sort((a, b) => Number(a > b) - Number(a < b))
    .map((k) => byKey.get(k) as T);
}

/** Every input of the image a Dockerfile builds, or why it cannot be keyed. */
export function analyzeDockerfile(text: string): DockerfileAnalysis {
  const inputs: ImageInputs = {
    bases: [],
    copies: [],
    apt: [],
    urls: [],
    npm: [],
    pypi: [],
    scripts: [],
  };
  try {
    const stages = new Map<string, Stage>();
    let stage: Stage | undefined;
    let copies: CopyTarget[] = [];
    for (const { keyword, args } of dockerfileInstructions(text)) {
      if (!ALLOWED_INSTRUCTIONS.has(keyword)) unsupported(`instruction ${keyword}`);
      if (keyword === 'FROM') {
        const [reference, as, name, ...extra] = args.split(/\s+/);
        if (
          reference.startsWith('--') ||
          extra.length ||
          (as && (as.toUpperCase() !== 'AS' || !name))
        )
          unsupported(`FROM ${args}`);
        const parent = stages.get(reference.toLowerCase());
        const digest = parent?.digest ?? DIGEST_REF.exec(reference)?.[1];
        if (!digest) unsupported(`base image ${reference} is not pinned by digest`);
        if (!parent) inputs.bases.push(reference);
        stage = { digest, apt: parent ? [...parent.apt] : [] };
        copies = [];
        if (name) stages.set(name.toLowerCase(), stage);
        continue;
      }
      if (!stage) unsupported(`${keyword} before FROM`);
      if (keyword === 'COPY') {
        const before = copies.length;
        analyzeCopy(args, stages, copies);
        inputs.copies.push(...copies.slice(before).map((copy) => copy.source));
      } else if (keyword === 'RUN') analyzeRun(args, { stage, copies, inputs });
    }
    if (!stage) unsupported('no FROM');
  } catch (error) {
    if (error instanceof Unsupported) return { ok: false, reason: error.message };
    throw error;
  }
  const identity = (value: string) => value;
  return {
    ok: true,
    inputs: {
      bases: sortedUnique(inputs.bases, identity),
      copies: sortedUnique(inputs.copies, identity),
      apt: sortedUnique(inputs.apt, aptSourceId),
      urls: sortedUnique(inputs.urls, identity),
      npm: sortedUnique(inputs.npm, identity),
      pypi: sortedUnique(inputs.pypi, pypiToolId),
      scripts: sortedUnique(inputs.scripts, identity),
    },
  };
}

export function aptSourceId(source: AptSource): string {
  return `${source.url} ${source.suite} ${[...source.components].sort().join(',')}`;
}

export function pypiToolId(tool: PypiTool): string {
  return `${tool.spec} python=${tool.python} with=${[...tool.with].sort().join(',')}`;
}

/** Fingerprints of every input in an `ImageInputs`, keyed by input identity. */
export interface InputFingerprints {
  /** Context path -> `<octal mode>:<sha256 of bytes>`. */
  files: Record<string, string>;
  apt: Record<string, string>;
  urls: Record<string, string>;
  npm: Record<string, string>;
  pypi: Record<string, string>;
}

/** Bumping this invalidates every recorded key. */
export const IMAGE_KEY_SCHEMA = 'sam-container-image-key-v1';

/**
 * Content key of an image. Throws when any input lacks a fingerprint, so a
 * partial fingerprint can never produce a key.
 */
export function composeImageKey(input: {
  dockerfilePath: string;
  dockerfile: string;
  inputs: ImageInputs;
  fingerprints: InputFingerprints;
  buildFlags: readonly string[];
}): string {
  const { inputs, fingerprints } = input;
  const pick = (table: Record<string, string>, id: string) => {
    const value = table[id];
    if (!value) throw new Error(`Missing fingerprint for ${id}`);
    return [id, value];
  };
  for (const script of inputs.scripts) {
    const reviewed = REVIEWED_BUILD_SCRIPTS[script];
    if (!reviewed || fingerprints.files[script]?.split(':')[1] !== reviewed.sha256)
      throw new Error(`${script} differs from its reviewed content (REVIEWED_BUILD_SCRIPTS)`);
  }
  const canonical = JSON.stringify({
    schema: IMAGE_KEY_SCHEMA,
    dockerfile: [input.dockerfilePath, createHash('sha256').update(input.dockerfile).digest('hex')],
    buildFlags: input.buildFlags,
    bases: inputs.bases,
    files: inputs.copies.map((path) => pick(fingerprints.files, path)),
    apt: inputs.apt.map((source) => pick(fingerprints.apt, aptSourceId(source))),
    urls: inputs.urls.map((url) => pick(fingerprints.urls, url)),
    npm: inputs.npm.map((spec) => pick(fingerprints.npm, spec)),
    pypi: inputs.pypi.map((tool) => pick(fingerprints.pypi, pypiToolId(tool))),
  });
  return createHash('sha256').update(canonical).digest('hex');
}
