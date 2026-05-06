/**
 * Mock tool implementations for eval scenarios.
 *
 * These mirror the Go harness tools (read_file, grep, glob, edit_file, write_file, bash)
 * but operate on a virtual filesystem so scenarios are deterministic and network-free.
 */

import type { EvalTool, ToolDefinition } from './types.js';

// ---------------------------------------------------------------------------
// Virtual filesystem for deterministic tool execution
// ---------------------------------------------------------------------------

export interface VirtualFile {
  path: string;
  content: string;
}

/**
 * Create a virtual filesystem from a list of files.
 * Returns tool implementations that operate on this filesystem.
 */
export function createVirtualFs(files: VirtualFile[]): Map<string, string> {
  const fs = new Map<string, string>();
  for (const f of files) {
    fs.set(f.path, f.content);
  }
  return fs;
}

// ---------------------------------------------------------------------------
// Tool definitions (OpenAI function-calling format)
// ---------------------------------------------------------------------------

export const READ_FILE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'read_file',
    description: 'Read the contents of a file. Returns the file content with line numbers.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
      },
      required: ['path'],
    },
  },
};

export const GREP_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'grep',
    description: 'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        include: { type: 'string', description: 'Glob pattern for files to search (e.g., "*.ts")' },
      },
      required: ['pattern'],
    },
  },
};

export const GLOB_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'glob',
    description: 'Find files matching a glob pattern. Returns a list of matching file paths.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/*.go")' },
      },
      required: ['pattern'],
    },
  },
};

export const EDIT_FILE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'edit_file',
    description: 'Replace a string in a file. The old_string must appear exactly once in the file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        old_string: { type: 'string', description: 'The exact text to find and replace' },
        new_string: { type: 'string', description: 'The replacement text' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
  },
};

export const WRITE_FILE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Create or overwrite a file with the given content.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the project root' },
        content: { type: 'string', description: 'File content to write' },
      },
      required: ['path', 'content'],
    },
  },
};

export const GET_WEATHER_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather for a city. Returns temperature in Fahrenheit and condition.',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'City name (e.g., "Paris")' },
      },
      required: ['city'],
    },
  },
};

export const CALCULATE_DEF: ToolDefinition = {
  type: 'function',
  function: {
    name: 'calculate',
    description: 'Evaluate a mathematical expression and return the result.',
    parameters: {
      type: 'object',
      properties: {
        expression: { type: 'string', description: 'Math expression (e.g., "(72 - 32) * 5/9")' },
      },
      required: ['expression'],
    },
  },
};

// ---------------------------------------------------------------------------
// Tool handler factories
// ---------------------------------------------------------------------------

/**
 * Create a read_file tool that operates on a virtual filesystem.
 */
export function makeReadFile(vfs: Map<string, string>): EvalTool {
  return {
    definition: READ_FILE_DEF,
    handler: (args) => {
      const path = String(args.path ?? '');
      const content = vfs.get(path);
      if (content === undefined) {
        return `Error: file not found: ${path}`;
      }
      const lines = content.split('\n');
      const numbered = lines.map((line, i) => `${String(i + 1).padStart(4)}  ${line}`);
      return numbered.join('\n');
    },
  };
}

/**
 * Create a grep tool that operates on a virtual filesystem.
 */
export function makeGrep(vfs: Map<string, string>): EvalTool {
  return {
    definition: GREP_DEF,
    handler: (args) => {
      const pattern = String(args.pattern ?? '');
      const include = args.include ? String(args.include) : undefined;
      let re: RegExp;
      try {
        re = new RegExp(pattern);
      } catch {
        return `Error: invalid regex pattern: ${pattern}`;
      }

      const results: string[] = [];
      for (const [filePath, content] of vfs) {
        // Simple include filter (just file extension matching)
        if (include) {
          const ext = include.replace('*', '');
          if (!filePath.endsWith(ext)) continue;
        }
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            results.push(`${filePath}:${i + 1}:${lines[i]}`);
          }
        }
      }
      return results.length > 0 ? results.join('\n') : 'No matches found.';
    },
  };
}

/**
 * Create a glob tool that operates on a virtual filesystem.
 */
export function makeGlob(vfs: Map<string, string>): EvalTool {
  return {
    definition: GLOB_DEF,
    handler: (args) => {
      const pattern = String(args.pattern ?? '');
      const paths = Array.from(vfs.keys());

      // Simple glob matching: ** matches everything, * matches within path segment
      const matched = paths.filter((p) => {
        if (pattern.includes('**')) {
          const suffix = pattern.replace('**/', '').replace('**', '');
          return p.endsWith(suffix) || suffix === '';
        }
        if (pattern.startsWith('*.')) {
          return p.endsWith(pattern.slice(1));
        }
        return p.includes(pattern.replace('*', ''));
      });

      return matched.length > 0 ? matched.join('\n') : 'No files matched.';
    },
  };
}

/**
 * Create an edit_file tool that operates on a virtual filesystem (mutates vfs).
 */
export function makeEditFile(vfs: Map<string, string>): EvalTool {
  return {
    definition: EDIT_FILE_DEF,
    handler: (args) => {
      const path = String(args.path ?? '');
      const oldStr = String(args.old_string ?? '');
      const newStr = String(args.new_string ?? '');

      const content = vfs.get(path);
      if (content === undefined) {
        return `Error: file not found: ${path}`;
      }

      const count = content.split(oldStr).length - 1;
      if (count === 0) {
        return `Error: old_string not found in ${path}`;
      }
      if (count > 1) {
        return `Error: old_string found ${count} times in ${path} (must be unique)`;
      }

      const updated = content.replace(oldStr, newStr);
      vfs.set(path, updated);
      return `File ${path} edited successfully.`;
    },
  };
}

/**
 * Create a write_file tool that operates on a virtual filesystem (mutates vfs).
 */
export function makeWriteFile(vfs: Map<string, string>): EvalTool {
  return {
    definition: WRITE_FILE_DEF,
    handler: (args) => {
      const path = String(args.path ?? '');
      const content = String(args.content ?? '');
      vfs.set(path, content);
      return `File ${path} written successfully.`;
    },
  };
}

/**
 * Weather tool (mock — always returns sunny 72F for any city).
 */
export function makeGetWeather(): EvalTool {
  return {
    definition: GET_WEATHER_DEF,
    handler: (args) => {
      return JSON.stringify({
        city: args.city ?? 'Unknown',
        temperature_f: 72,
        condition: 'sunny',
        humidity_percent: 45,
      });
    },
  };
}

/**
 * Calculate tool (safe math eval).
 */
export function makeCalculate(): EvalTool {
  return {
    definition: CALCULATE_DEF,
    handler: (args) => {
      const expr = String(args.expression ?? '');
      const sanitized = expr.replace(/[^0-9+\-*/().% ]/g, '');
      if (sanitized !== expr) {
        return JSON.stringify({ error: 'Invalid expression — only numbers and basic math operators allowed' });
      }
      try {
        // eslint-disable-next-line no-eval
        const result = Function(`"use strict"; return (${sanitized})`)();
        return JSON.stringify({ result: Number(Number(result).toFixed(4)) });
      } catch {
        return JSON.stringify({ error: 'Evaluation failed' });
      }
    },
  };
}
