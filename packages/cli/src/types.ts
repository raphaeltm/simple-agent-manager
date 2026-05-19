export type TaskMode = 'task' | 'conversation';

export interface CliConfig {
  apiUrl: string;
  sessionCookie: string;
}

export interface ConfigPaths {
  configDir: string;
  configFile: string;
}

export interface ConfigEnv {
  [key: string]: string | undefined;
  HOME?: string;
  XDG_CONFIG_HOME?: string;
  APPDATA?: string;
  SAM_CONFIG_DIR?: string;
  SAM_API_URL?: string;
  SAM_SESSION_COOKIE?: string;
}

export interface Logger {
  error(message: string): void;
  log(message: string): void;
}

export interface Runtime {
  env: ConfigEnv;
  fetch: typeof fetch;
  logger: Logger;
  readStdin?: () => Promise<string>;
}

export interface GlobalOptions {
  json: boolean;
}

export interface LoginOptions {
  apiUrl?: string;
  sessionCookie?: string;
  sessionCookieStdin: boolean;
}

export interface TaskSubmitOptions {
  agentProfileId?: string;
  agentType?: string;
  contextSummary?: string;
  devcontainerConfigName?: string | null;
  mode?: TaskMode;
  nodeId?: string;
  parentTaskId?: string;
  provider?: string;
  vmLocation?: string;
  vmSize?: string;
  workspaceProfile?: string;
}

export interface ApiErrorBody {
  error?: string;
  message?: string;
}

export interface SubmitTaskResponse {
  taskId: string;
  sessionId: string;
  branchName: string;
  status: string;
}

export interface TaskStatusResponse {
  id: string;
  title: string;
  status: string;
  executionStep: string | null;
  taskMode?: string;
  outputBranch: string | null;
  outputPrUrl: string | null;
  outputSummary: string | null;
  errorMessage: string | null;
  finalizedAt: string | null;
  updatedAt: string;
}

export interface SessionPromptResponse {
  success?: boolean;
  message?: string;
}
