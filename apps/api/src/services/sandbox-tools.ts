/**
 * Sandbox tool definitions and dispatcher.
 *
 * Defines 5 sandbox tools as OpenAI-compatible tool definitions for use
 * in the ProjectAgent DO agent loop. Each tool maps to a Sandbox SDK method
 * (exec, files.read, files.write, files.list, or exec for git clone).
 *
 * Gated behind SANDBOX_ENABLED env var — when disabled, no sandbox behavior at all.
 */
import type { SandboxExecResult, SandboxFileListResult, SandboxFileReadResult } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../lib/logger';

const log = createModuleLogger('sandbox_tools');

// =============================================================================
// Types
// =============================================================================

/** OpenAI-compatible tool definition. */
export interface SandboxToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, unknown>;
      required: string[];
    };
  };
}

/**
 * Minimal sandbox interface — matches the subset of the Sandbox SDK we use.
 * Allows mocking in tests without importing @cloudflare/sandbox.
 */
/**
 * Minimal sandbox interface for tool execution.
 *
 * Matches the subset of the @cloudflare/sandbox Sandbox class we use.
 * Cast the SDK result via `as unknown as SandboxHandle` since the SDK
 * types use concrete interfaces that don't satisfy index signatures.
 */
export interface SandboxHandle {
  exec(command: string, opts?: { timeout?: number }): Promise<{
    stdout: string;
    stderr: string;
    exitCode: number;
    success: boolean;
  }>;
  readFile(path: string, opts?: { encoding?: string }): Promise<{ content: string }>;
  writeFile(path: string, content: string, opts?: { encoding?: string }): Promise<unknown>;
  listFiles(path: string, opts?: unknown): Promise<{
    files: Array<{ name: string }>;
    count: number;
  }>;
}

// =============================================================================
// Tool definitions
// =============================================================================

const sandboxExecDef: SandboxToolDef = {
  type: 'function',
  function: {
    name: 'sandbox_exec',
    description:
      'Execute a shell command in the project sandbox container. Returns stdout, stderr, and exit code.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The shell command to execute' },
        timeout_ms: {
          type: 'number',
          description: 'Timeout in milliseconds (default: 30000)',
        },
      },
      required: ['command'],
    },
  },
};

const sandboxReadFileDef: SandboxToolDef = {
  type: 'function',
  function: {
    name: 'sandbox_read_file',
    description: 'Read the contents of a file from the sandbox filesystem.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to read' },
      },
      required: ['path'],
    },
  },
};

const sandboxWriteFileDef: SandboxToolDef = {
  type: 'function',
  function: {
    name: 'sandbox_write_file',
    description: 'Write content to a file in the sandbox filesystem. Creates or overwrites the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path to the file to write' },
        content: { type: 'string', description: 'Content to write to the file' },
      },
      required: ['path', 'content'],
    },
  },
};

const sandboxListFilesDef: SandboxToolDef = {
  type: 'function',
  function: {
    name: 'sandbox_list_files',
    description: 'List files and directories in a sandbox directory.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the directory to list (default: /workspace)',
        },
      },
      required: [],
    },
  },
};

const sandboxGitCloneDef: SandboxToolDef = {
  type: 'function',
  function: {
    name: 'sandbox_git_clone',
    description:
      'Clone a git repository into the sandbox. Uses shallow clone by default for speed.',
    parameters: {
      type: 'object',
      properties: {
        repo_url: { type: 'string', description: 'Git repository URL to clone' },
        branch: { type: 'string', description: 'Branch to clone (default: main)' },
        target_dir: {
          type: 'string',
          description: 'Target directory (default: /workspace)',
        },
        depth: {
          type: 'number',
          description: 'Clone depth for shallow clone (default: 1)',
        },
      },
      required: ['repo_url'],
    },
  },
};

/** All sandbox tool definitions for use in the agent loop. */
export const SANDBOX_TOOLS: SandboxToolDef[] = [
  sandboxExecDef,
  sandboxReadFileDef,
  sandboxWriteFileDef,
  sandboxListFilesDef,
  sandboxGitCloneDef,
];

/** Tool names for lookup. */
export const SANDBOX_TOOL_NAMES = new Set(SANDBOX_TOOLS.map((t) => t.function.name));

// =============================================================================
// Tool execution
// =============================================================================

/** Execute a sandbox tool by name and return a structured result. */
export async function executeSandboxTool(
  sandbox: SandboxHandle,
  toolName: string,
  args: Record<string, unknown>,
  defaultExecTimeoutMs: number = 30_000,
  defaultGitTimeoutMs: number = 120_000,
): Promise<SandboxExecResult | SandboxFileReadResult | SandboxFileListResult | { success: true } | { error: string }> {
  const start = Date.now();

  switch (toolName) {
    case 'sandbox_exec': {
      const command = args.command as string;
      if (!command) return { error: 'command is required' };
      const timeoutMs = (args.timeout_ms as number) || defaultExecTimeoutMs;

      log.info('sandbox_tools.exec', { command: command.slice(0, 200), timeoutMs });
      const result = await sandbox.exec(command, { timeout: timeoutMs });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        success: result.success,
        durationMs: Date.now() - start,
      };
    }

    case 'sandbox_read_file': {
      const path = args.path as string;
      if (!path) return { error: 'path is required' };

      log.info('sandbox_tools.read_file', { path });
      const file = await sandbox.readFile(path);
      return { content: file.content, durationMs: Date.now() - start };
    }

    case 'sandbox_write_file': {
      const path = args.path as string;
      const content = args.content as string;
      if (!path) return { error: 'path is required' };
      if (typeof content !== 'string') return { error: 'content is required' };

      log.info('sandbox_tools.write_file', { path, contentLength: content.length });
      await sandbox.writeFile(path, content);
      return { success: true };
    }

    case 'sandbox_list_files': {
      const path = (args.path as string) || '/workspace';

      log.info('sandbox_tools.list_files', { path });
      const result = await sandbox.listFiles(path);
      const entries = result.files.map((f) => f.name);
      return { entries, durationMs: Date.now() - start };
    }

    case 'sandbox_git_clone': {
      const repoUrl = args.repo_url as string;
      if (!repoUrl) return { error: 'repo_url is required' };
      const branch = (args.branch as string) || 'main';
      const targetDir = (args.target_dir as string) || '/workspace';
      const depth = (args.depth as number) || 1;

      const cloneCmd = `git clone --depth=${depth} --branch=${branch} ${repoUrl} ${targetDir}`;
      log.info('sandbox_tools.git_clone', { branch, targetDir, depth });
      const result = await sandbox.exec(cloneCmd, { timeout: defaultGitTimeoutMs });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        success: result.success,
        durationMs: Date.now() - start,
      };
    }

    default:
      return { error: `Unknown sandbox tool: ${toolName}` };
  }
}
