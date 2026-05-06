/**
 * Scenario: Missing File Recovery
 *
 * Tests the model's ability to handle a read_file error gracefully
 * and recover by using glob/grep to find the correct file.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeGrep, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/config/database.ts',
    content: `export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  ssl: boolean;
}

export const DEFAULT_CONFIG: DatabaseConfig = {
  host: 'localhost',
  port: 5432,
  database: 'app_dev',
  ssl: false,
};

export function buildConnectionString(config: DatabaseConfig): string {
  const protocol = config.ssl ? 'postgresql+ssl' : 'postgresql';
  return \`\${protocol}://\${config.host}:\${config.port}/\${config.database}\`;
}
`,
  },
  {
    path: 'src/config/index.ts',
    content: `export { DEFAULT_CONFIG, buildConnectionString } from './database';
export type { DatabaseConfig } from './database';
`,
  },
  {
    path: 'src/server.ts',
    content: `import { buildConnectionString, DEFAULT_CONFIG } from './config';

const connStr = buildConnectionString(DEFAULT_CONFIG);
console.log('Connecting to', connStr);
`,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'missing-file-recovery',
  name: 'Missing File Error Recovery',
  category: 'coding',
  description: 'Model tries to read a nonexistent file, gets an error, and recovers by searching for the correct path.',

  systemPrompt:
    'You are a code analysis assistant. Use the provided tools to search and read source files. If a file is not found, use glob or grep to locate it.',

  userPrompt:
    'Read the database configuration from src/db.ts and explain the default connection settings.',

  tools: [makeReadFile(vfs), makeGrep(vfs), makeGlob(vfs)],

  maxTurns: 6,

  evaluate: (run: ScenarioRun) => {
    const checks = [
      {
        name: 'attempted_wrong_path',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'read_file' &&
            /db\.ts/i.test(JSON.stringify(tc.arguments)) &&
            tc.result.includes('Error'),
        ),
        detail: 'Model should first try src/db.ts and get an error',
      },
      {
        name: 'recovered_with_search',
        pass: run.toolCalls.some(
          (tc) => tc.toolName === 'glob' || tc.toolName === 'grep',
        ),
        detail: 'Model should use glob or grep to find the correct file',
      },
      {
        name: 'found_correct_file',
        pass: run.toolCalls.some(
          (tc) =>
            tc.toolName === 'read_file' &&
            /database\.ts|config/i.test(JSON.stringify(tc.arguments)) &&
            !tc.isError,
        ),
        detail: 'Model should eventually read the correct database config file',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete with an answer',
      },
      {
        name: 'describes_config',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /localhost|5432|app_dev|connection/i.test(m.content),
        ),
        detail: 'Answer should describe the default database config values',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully recovered from missing file and found correct config'
        : `Failed checks: ${checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(', ')}`,
      checks,
    };
  },
};

export default scenario;
