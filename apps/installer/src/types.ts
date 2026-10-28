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
  INSTALL_SOURCE_COMMIT?: string;
  OAUTH_CLEANUP_RESERVE_SECONDS?: string;
  MIN_PROVISION_SECONDS?: string;
  PROVISION_TIMEOUT_SECONDS?: string;
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
  zones?: { id: string; name: string; account: { id: string } }[];
  plan?: import('./installation-plan').InstallationPlan;
  credentials?: import('./credentials').InstallationCredentials;
  credentialTokenIds?: string[];
  job?: {
    accountId: string;
    name: string;
    url?: string;
    key: string;
    status: 'pending' | 'ready';
    fingerprint?: string;
    authorityTransferred?: boolean;
    authorityTransferStarted?: boolean;
  };
}

/** Non-secret evidence retained only when cleanup needs a fresh authorized grant. */
export interface CleanupJournal {
  accountId: string;
  installationId: string;
  bootstrapIdentity: string;
  tokenIds: string[];
  authorityTransferStarted: boolean;
  authorityTransferred: boolean;
}
