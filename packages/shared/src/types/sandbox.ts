/**
 * Sandbox agent configuration types.
 *
 * Used by ProjectAgent and SamSession DOs when SANDBOX_ENABLED is true
 * to configure sandbox-backed coding tool execution.
 */

/** Configuration for a sandbox-based agent session. */
export interface SandboxAgentConfig {
  /** Model ID for the agent loop (resolved from project/platform config). */
  modelId: string;
  /** Sandbox instance ID (derived from project ID for isolation). */
  sandboxId: string;
  /** Maximum think-act-observe cycles per invocation. From SANDBOX_AGENT_MAX_TURNS. */
  maxTurns: number;
  /** Per-command execution timeout in ms. From SANDBOX_EXEC_TIMEOUT_MS. */
  execTimeoutMs: number;
  /** Git clone timeout in ms. From SANDBOX_GIT_TIMEOUT_MS. */
  gitTimeoutMs: number;
  /** Repository URL for initial clone (includes access token). */
  repoUrl: string;
  /** Branch to clone. From project.defaultBranch or 'main'. */
  branch: string;
}

/** Result of a sandbox command execution. */
export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  durationMs: number;
}

/** Result of a sandbox file read. */
export interface SandboxFileReadResult {
  content: string;
  durationMs: number;
}

/** Result of a sandbox file list. */
export interface SandboxFileListResult {
  entries: string[];
  durationMs: number;
}
