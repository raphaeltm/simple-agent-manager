/** Managed runtime env secrets are delivered only to the selected job process. */
export interface SecretExecRequest {
  argv?: string[];
  command?: string;
  shell?: 'bash' | 'sh';
  secretNames: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  idempotencyKey?: string;
}
export interface SecretExecResult {
  jobId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  redacted: boolean;
  truncated: boolean;
  execution: {
    containerId: string;
    user: string;
    cwd: string;
    environmentMode: 'placeholder' | 'legacy';
  };
}
