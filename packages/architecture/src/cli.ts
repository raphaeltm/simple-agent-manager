#!/usr/bin/env node
import path from 'node:path';

import { DEFAULT_THREADS_DIR } from './constants';
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

type ValueOptionHandler = (options: CliOptions, value: string) => void;

const VALUE_OPTION_HANDLERS: Readonly<Record<string, ValueOptionHandler>> = {
  '--workspace': (options, value) => {
    options.workspaceRoot = value;
  },
  '--repo': (options, value) => {
    options.repoRoot = value;
  },
  '--body': (options, value) => {
    options.body = value;
  },
  '--target': (options, value) => {
    options.target = value;
  },
  '--title': (options, value) => {
    options.title = value;
  },
  '--thread': (options, value) => {
    options.thread = value;
  },
  '--author': (options, value) => {
    options.author = value;
  },
  '--host': (options, value) => {
    options.host = value;
  },
  '--port': (options, value) => {
    options.port = parsePort(value);
  },
};

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
  printResult(getWorkspaceSummary(loaded.workspace));
  return 0;
}

async function showCommand(positional: string[], options: CliOptions): Promise<number> {
  const elementId = positional[0];
  if (!elementId) throw new Error('show requires an element id.');
  const loaded = await loadOrFail(options);
  const details = showElement(loaded.workspace, elementId);
  if (!details) throw new Error(`Element not found: ${elementId}`);
  printResult(details);
  return 0;
}

async function inboxCommand(options: CliOptions): Promise<number> {
  const loaded = await loadOrFail(options);
  printResult(listUnresolvedInbox(loaded.workspace));
  return 0;
}

async function replyCommand(options: CliOptions): Promise<number> {
  if (!options.body) throw new Error('reply requires --body.');
  const loaded = await loadOrFail(options);
  const threadsDir = loaded.workspace.manifest.threadsDir;
  if (options.thread) {
    const artifactPath = threadArtifactPath(loaded.workspace, options.thread);
    const message = await appendThreadReply({
      workspaceRoot: options.workspaceRoot ?? 'architecture',
      threadsDir,
      threadId: options.thread,
      body: options.body,
      author: options.author,
    });
    printResult({ message, artifactPath });
    return 0;
  }
  if (!options.target) throw new Error('reply without --thread requires --target.');
  if (!resolveArchitectureTarget(loaded.workspace, options.target)) {
    throw new Error(`Thread target not found: ${options.target}`);
  }
  const thread = await createThread({
    workspaceRoot: options.workspaceRoot ?? 'architecture',
    threadsDir,
    target: options.target,
    title: options.title ?? `Question for ${options.target}`,
    body: options.body,
    author: options.author,
  });
  printResult({ thread, artifactPath: threadArtifactPath(loaded.workspace, thread.id) });
  return 0;
}

function threadArtifactPath(
  workspace: Awaited<ReturnType<typeof loadArchitectureWorkspace>>['workspace'],
  threadId: string
): string {
  const location = workspace.indexes.threadsById.get(threadId)?.location.file;
  const workspaceRelative =
    location ?? `${workspace.manifest.threadsDir ?? DEFAULT_THREADS_DIR}/${threadId}.thread.md`;
  return path.relative(workspace.repoRoot, path.join(workspace.workspaceRoot, workspaceRelative));
}

async function impactCommand(positional: string[], options: CliOptions): Promise<number> {
  if (positional.length === 0)
    throw new Error('impact requires at least one repo-relative changed path.');
  const loaded = await loadOrFail(options);
  const report = await mapChangedPathsToArchitecture(loaded.workspace, positional);
  printResult(report);
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

function printResult(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
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
    const valueOptionHandler = VALUE_OPTION_HANDLERS[arg];
    if (valueOptionHandler) {
      valueOptionHandler(options, readOptionValue(rest, index, arg));
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
