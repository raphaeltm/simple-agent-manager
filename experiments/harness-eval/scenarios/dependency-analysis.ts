/**
 * Scenario: Dependency Analysis
 *
 * Tests the model's ability to read imports across multiple files and
 * produce a dependency graph. Requires glob to discover files, read_file
 * to parse imports, and structured output.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeGrep, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/index.ts',
    content: `import { createApp } from './app';
import { loadConfig } from './config';
import { connectDb } from './db';

async function main() {
  const config = loadConfig();
  const db = await connectDb(config.dbUrl);
  const app = createApp(db);
  app.listen(config.port);
}

main();
`,
  },
  {
    path: 'src/app.ts',
    content: `import { Router } from './router';
import { authMiddleware } from './middleware/auth';
import { logMiddleware } from './middleware/log';
import type { Database } from './db';

export function createApp(db: Database) {
  const router = new Router();
  router.use(logMiddleware);
  router.use(authMiddleware);
  router.mount('/api', apiRoutes(db));
  return router;
}

function apiRoutes(db: Database) {
  return { get: (path: string) => db.query(path) };
}
`,
  },
  {
    path: 'src/config.ts',
    content: `export interface AppConfig {
  port: number;
  dbUrl: string;
  logLevel: string;
}

export function loadConfig(): AppConfig {
  return {
    port: Number(process.env.PORT) || 3000,
    dbUrl: process.env.DATABASE_URL || 'sqlite://local.db',
    logLevel: process.env.LOG_LEVEL || 'info',
  };
}
`,
  },
  {
    path: 'src/db.ts',
    content: `import { Logger } from './logger';

export interface Database {
  query(sql: string): Promise<unknown[]>;
  close(): Promise<void>;
}

export async function connectDb(url: string): Promise<Database> {
  const logger = new Logger('db');
  logger.info(\`Connecting to \${url}\`);
  return {
    query: async (sql) => {
      logger.debug(\`Query: \${sql}\`);
      return [];
    },
    close: async () => {
      logger.info('Connection closed');
    },
  };
}
`,
  },
  {
    path: 'src/router.ts',
    content: `export type Middleware = (req: unknown, next: () => void) => void;

export class Router {
  private middlewares: Middleware[] = [];
  private routes: Map<string, unknown> = new Map();

  use(mw: Middleware) {
    this.middlewares.push(mw);
  }

  mount(path: string, handler: unknown) {
    this.routes.set(path, handler);
  }

  listen(port: number) {
    console.log(\`Listening on port \${port}\`);
  }
}
`,
  },
  {
    path: 'src/logger.ts',
    content: `export class Logger {
  constructor(private context: string) {}

  info(msg: string) {
    console.log(\`[\${this.context}] INFO: \${msg}\`);
  }

  debug(msg: string) {
    console.log(\`[\${this.context}] DEBUG: \${msg}\`);
  }

  error(msg: string) {
    console.error(\`[\${this.context}] ERROR: \${msg}\`);
  }
}
`,
  },
  {
    path: 'src/middleware/auth.ts',
    content: `import { Logger } from '../logger';

const logger = new Logger('auth');

export function authMiddleware(req: unknown, next: () => void) {
  logger.info('Checking auth');
  next();
}
`,
  },
  {
    path: 'src/middleware/log.ts',
    content: `import { Logger } from '../logger';

const logger = new Logger('request');

export function logMiddleware(req: unknown, next: () => void) {
  logger.info('Request received');
  next();
}
`,
  },
];

const vfs = createVirtualFs(FILES);

/**
 * The correct dependency graph (what imports what):
 *
 *   index -> app, config, db
 *   app -> router, middleware/auth, middleware/log, db
 *   db -> logger
 *   middleware/auth -> logger
 *   middleware/log -> logger
 *   config -> (none)
 *   router -> (none)
 *   logger -> (none)
 */

const scenario: EvalScenario = {
  id: 'dependency-analysis',
  name: 'Analyze Import Dependencies',
  category: 'coding',
  description:
    'Read imports across 8 files and produce a dependency graph. Tests multi-file navigation and structured output.',

  systemPrompt:
    'You are a code analysis assistant. Use the provided tools to read source files and analyze code structure. Produce clear, structured output.',

  userPrompt: [
    'Analyze the dependency graph for the TypeScript project in src/.',
    'For each file, list what other files it imports from.',
    'Produce the output as a structured list like:',
    '',
    '  src/index.ts -> src/app.ts, src/config.ts, src/db.ts',
    '  src/app.ts -> src/router.ts, ...',
    '',
    'Include ALL files. Use glob to discover them, then read each one.',
  ].join('\n'),

  tools: [makeReadFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 15,

  evaluate: (run: ScenarioRun) => {
    // The model's final message should contain the dependency graph
    const finalMessages = run.messages.filter(
      (m) => m.role === 'assistant' && !m.tool_calls?.length && m.content != null,
    );
    const finalText = finalMessages.map((m) => m.content ?? '').join('\n');

    // Key relationships that must be present
    const keyDeps = [
      { from: 'index', to: 'app', label: 'index -> app' },
      { from: 'index', to: 'config', label: 'index -> config' },
      { from: 'index', to: 'db', label: 'index -> db' },
      { from: 'app', to: 'router', label: 'app -> router' },
      { from: 'app', to: 'auth', label: 'app -> middleware/auth' },
      { from: 'db', to: 'logger', label: 'db -> logger' },
    ];

    const depChecks = keyDeps.map(({ from, to, label }) => ({
      name: `dep_${from}_${to}`,
      pass: finalText.includes(from) && finalText.includes(to) &&
        // Check they appear in some dependency relationship
        new RegExp(`${from}[^\\n]*${to}|${from}[^\\n]*->[^\\n]*${to}`, 'i').test(finalText),
      detail: label,
    }));

    // Check that the model read multiple files
    const filesRead = new Set(
      run.toolCalls
        .filter((tc) => tc.toolName === 'read_file')
        .map((tc) => String(tc.arguments.path)),
    );

    const checks = [
      {
        name: 'used_glob_or_grep',
        pass: run.toolCalls.some((tc) => tc.toolName === 'glob' || tc.toolName === 'grep'),
        detail: 'Model should discover files via glob or grep',
      },
      {
        name: 'read_multiple_files',
        pass: filesRead.size >= 4,
        detail: `Should read at least 4 files (read: ${filesRead.size})`,
      },
      ...depChecks,
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete with the dependency graph',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    const failedCount = checks.filter((c) => !c.pass).length;
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully analyzed and reported the dependency graph'
        : `Failed ${failedCount} checks: ${checks.filter((c) => !c.pass).map((c) => c.name).join(', ')}`,
      checks,
    };
  },
};

export default scenario;
