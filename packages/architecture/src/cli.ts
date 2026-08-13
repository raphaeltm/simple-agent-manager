#!/usr/bin/env node
import { formatDiagnostics, hasErrors } from './diagnostics';
import { mapChangedPathsToArchitecture } from './impact';
import { loadArchitectureWorkspace } from './loader';
import { getWorkspaceSummary, listUnresolvedInbox, showElement } from './queries';
import { startArchitectureServer } from './server';
import { resolveArchitectureTarget } from './targets';
import { appendThreadReply, createThread } from './threads';

interface CliOptions {
  workspaceRoot?: string;
  repoRoot?: string;
  json: boolean;
  body?: string;
  target?: string;
  title?: string;
  thread?: string;
  author?: string;
  host?: string;
  port?: number;
}

export async function runCli(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { command, positional, options } = parseArgs(argv);
    switch (command) {
      case 'validate':
        return await validateCommand(options);
      case 'summary':
        return await summaryCommand(options);
      case 'show':
        return await showCommand(positional, options);
      case 'inbox':
        return await inboxCommand(options);
      case 'reply':
        return await replyCommand(options);
      case 'impact':
        return await impactCommand(positional, options);
      case 'serve':
        return await serveCommand(options);
      default:
        printUsage();
        return command ? 1 : 0;
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

async function validateCommand(options: CliOptions): Promise<number> {
  const loaded = await loadArchitectureWorkspace({
    workspaceRoot: options.workspaceRoot,
    repoRoot: options.repoRoot,
  });
  if (options.json) {
    console.log(JSON.stringify({ diagnostics: loaded.diagnostics }, null, 2));
  } else {
    console.log(formatDiagnostics(loaded.diagnostics));
  }
  return hasErrors(loaded.diagnostics) ? 1 : 0;
}

async function summaryCommand(options: CliOptions): Promise<number> {
  const loaded = await loadOrFail(options);
  printResult(getWorkspaceSummary(loaded.workspace), options.json);
  return 0;
}

async function showCommand(positional: string[], options: CliOptions): Promise<number> {
  const elementId = positional[0];
  if (!elementId) throw new Error('show requires an element id.');
  const loaded = await loadOrFail(options);
  const details = showElement(loaded.workspace, elementId);
  if (!details) throw new Error(`Element not found: ${elementId}`);
  printResult(details, options.json);
  return 0;
}

async function inboxCommand(options: CliOptions): Promise<number> {
  const loaded = await loadOrFail(options);
  printResult(listUnresolvedInbox(loaded.workspace), options.json);
  return 0;
}

async function replyCommand(options: CliOptions): Promise<number> {
  if (!options.body) throw new Error('reply requires --body.');
  if (options.thread) {
    const message = await appendThreadReply({
      workspaceRoot: options.workspaceRoot ?? 'architecture',
      threadId: options.thread,
      body: options.body,
      author: options.author,
    });
    printResult({ message }, options.json);
    return 0;
  }
  if (!options.target) throw new Error('reply without --thread requires --target.');
  const loaded = await loadOrFail(options);
  if (!resolveArchitectureTarget(loaded.workspace, options.target)) {
    throw new Error(`Thread target not found: ${options.target}`);
  }
  const thread = await createThread({
    workspaceRoot: options.workspaceRoot ?? 'architecture',
    target: options.target,
    title: options.title ?? `Question for ${options.target}`,
    body: options.body,
    author: options.author,
  });
  printResult({ thread }, options.json);
  return 0;
}

async function impactCommand(positional: string[], options: CliOptions): Promise<number> {
  if (positional.length === 0)
    throw new Error('impact requires at least one repo-relative changed path.');
  const loaded = await loadOrFail(options);
  const report = await mapChangedPathsToArchitecture(loaded.workspace, positional);
  printResult(report, options.json);
  return report.brokenSourceRefs.length > 0 ? 1 : 0;
}

async function serveCommand(options: CliOptions): Promise<number> {
  const running = await startArchitectureServer({
    workspaceRoot: options.workspaceRoot,
    repoRoot: options.repoRoot,
    host: options.host,
    port: options.port,
  });
  console.log(`Architecture workspace viewer: ${running.url}`);
  await new Promise<void>((resolve) => {
    process.once('SIGINT', resolve);
    process.once('SIGTERM', resolve);
  });
  await running.close();
  return 0;
}

async function loadOrFail(options: CliOptions): ReturnType<typeof loadArchitectureWorkspace> {
  const loaded = await loadArchitectureWorkspace({
    workspaceRoot: options.workspaceRoot,
    repoRoot: options.repoRoot,
  });
  if (hasErrors(loaded.diagnostics)) throw new Error(formatDiagnostics(loaded.diagnostics));
  return loaded;
}

function printResult(value: unknown, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(value, null, 2));
  } else {
    console.log(JSON.stringify(value, null, 2));
  }
}

function parseArgs(argv: string[]): { command: string; positional: string[]; options: CliOptions } {
  const normalizedArgv = argv[0] === '--' ? argv.slice(1) : argv;
  const [command = '', ...rest] = normalizedArgv;
  const options: CliOptions = { json: false };
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === undefined) continue;
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--') continue;
    if (arg === '--workspace') {
      options.workspaceRoot = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--repo') {
      options.repoRoot = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--body') {
      options.body = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--target') {
      options.target = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--title') {
      options.title = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--thread') {
      options.thread = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--author') {
      options.author = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--host') {
      options.host = readOptionValue(rest, index, arg);
      index += 1;
      continue;
    }
    if (arg === '--port') {
      options.port = parsePort(readOptionValue(rest, index, arg));
      index += 1;
      continue;
    }
    positional.push(arg);
  }
  return { command, positional, options };
}

function readOptionValue(args: string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value) throw new Error(`${option} requires a value.`);
  return value;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer from 0 to 65535.');
  }
  return port;
}

function printUsage(): void {
  console.log(`Usage: sam-architecture <command> [options]

Commands:
  validate              Validate the workspace and print diagnostics
  summary               Print compact workspace summary
  show <element-id>     Print bounded element details
  inbox                 List unresolved threads
  reply                 Create a thread or append a reply
  impact <paths...>     Map changed repo-relative paths to architecture records
  serve                 Start the loopback server and interactive viewer

Options:
  --workspace <path>    Architecture workspace root (default: architecture)
  --repo <path>         Repository root for source refs (default: cwd)
  --host <host>         Loopback host for serve (default: 127.0.0.1)
  --port <port>         Port for serve (default: named package default)
  --json               Emit JSON
`);
}

const executedPath = process.argv[1];
if (executedPath && import.meta.url === `file://${executedPath}`) {
  runCli().then((code) => {
    process.exitCode = code;
  });
}
