/**
 * Scenario: Read File and Summarize
 *
 * Tests the model's ability to read a source file and produce a meaningful summary.
 * Exercises: read_file tool, code comprehension, concise output.
 */

import type { EvalScenario, ScenarioRun } from '../types.js';
import { createVirtualFs, makeReadFile, makeGlob } from '../tools.js';

const FILES = [
  {
    path: 'src/auth.ts',
    content: `import { verify } from 'jsonwebtoken';
import type { Request, Response, NextFunction } from 'express';

interface JWTPayload {
  userId: string;
  role: 'admin' | 'user';
  exp: number;
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

export function authMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    throw new Error('Missing or invalid Authorization header');
  }
  const token = header.slice(7);
  const payload = verify(token, JWT_SECRET) as JWTPayload;
  req.user = { id: payload.userId, role: payload.role };
  next();
}

export function requireAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin') {
    throw new Error('Admin access required');
  }
  next();
}
`,
  },
  {
    path: 'src/index.ts',
    content: `import express from 'express';
import { authMiddleware } from './auth';

const app = express();
app.use(express.json());
app.use(authMiddleware);

app.get('/health', (_req, res) => res.json({ status: 'ok' }));
app.listen(3000);
`,
  },
];

const vfs = createVirtualFs(FILES);

const scenario: EvalScenario = {
  id: 'read-and-summarize',
  name: 'Read File and Summarize Code',
  category: 'coding',
  description: 'Model reads a TypeScript auth module and summarizes its functionality.',

  systemPrompt:
    'You are a code analysis assistant. Use the provided tools to read source files and answer questions about the codebase. Be concise and precise.',

  userPrompt:
    'Read src/auth.ts and give me a brief summary of what it does, including the key functions and their purposes.',

  tools: [makeReadFile(vfs), makeGlob(vfs)],

  maxTurns: 4,

  evaluate: (run: ScenarioRun) => {
    const checks = [
      {
        name: 'read_auth_file',
        pass: run.toolCalls.some(
          (tc) => tc.toolName === 'read_file' && String(tc.arguments.path).includes('auth'),
        ),
        detail: 'Model should read src/auth.ts',
      },
      {
        name: 'completed',
        pass: run.stopReason === 'complete',
        detail: 'Model should complete with a summary',
      },
      {
        name: 'mentions_auth_middleware',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /authMiddleware|auth.*middleware/i.test(m.content),
        ),
        detail: 'Summary should mention authMiddleware',
      },
      {
        name: 'mentions_jwt',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /jwt|token/i.test(m.content),
        ),
        detail: 'Summary should mention JWT/token verification',
      },
      {
        name: 'mentions_admin',
        pass: run.messages.some(
          (m) =>
            m.role === 'assistant' &&
            !m.tool_calls?.length &&
            m.content != null &&
            /admin|requireAdmin/i.test(m.content),
        ),
        detail: 'Summary should mention admin role checking',
      },
    ];

    const allPassed = checks.every((c) => c.pass);
    return {
      pass: allPassed,
      reason: allPassed
        ? 'Successfully read and summarized the auth module'
        : `Failed checks: ${checks
            .filter((c) => !c.pass)
            .map((c) => c.name)
            .join(', ')}`,
      checks,
    };
  },
};

export default scenario;
