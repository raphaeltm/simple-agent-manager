export interface Env {
  SESSIONS: DurableObjectNamespace;
  ASSETS: Fetcher;
  APP_ORIGIN: string;
  SESSION_TTL_SECONDS: string;
  OAUTH_SCOPES: string;
  OAUTH_CLIENT_ID?: string;
  OAUTH_CLIENT_SECRET?: string;
  SOURCE_URL: string;
  DOCS_URL: string;
  BUILD_SHA: string;
}
export interface Account {
  id: string;
  name: string;
}
export interface Session {
  expires: number;
  verifier: string;
  state: string;
  token?: string;
  tokenExpires?: number;
  accounts?: Account[];
  job?: { accountId: string; name: string; url?: string; key: string; status: 'pending' | 'ready' };
}
