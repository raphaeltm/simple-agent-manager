import type {
  CreateMcpConnectionRequest,
  McpConnection,
  McpConnectionAuthType,
  McpConnectionHeaderUpdate,
  UpdateMcpConnectionRequest,
} from '@simple-agent-manager/shared';

/**
 * One custom-header row in the MCP server form.
 *
 * `stored` rows already exist on the server. The API returns their names but never their
 * values, so a stored row's blank value means "keep the saved value" rather than "empty".
 */
export interface McpHeaderRow {
  /** React key only; never sent. */
  key: string;
  name: string;
  value: string;
  stored: boolean;
}

export interface McpServerFormState {
  name: string;
  /** Blank while editing means "keep the saved URL". */
  url: string;
  authType: McpConnectionAuthType;
  /** Blank while editing a bearer server means "keep the saved token". */
  token: string;
  headers: McpHeaderRow[];
}

export function newHeaderRow(): McpHeaderRow {
  return { key: crypto.randomUUID(), name: '', value: '', stored: false };
}

export function emptyMcpServerForm(): McpServerFormState {
  return { name: '', url: '', authType: 'bearer', token: '', headers: [] };
}

/** An edit starts from everything the API can tell us: names, never secrets. */
export function mcpServerFormFor(connection: McpConnection): McpServerFormState {
  return {
    name: connection.name,
    url: '',
    authType: connection.authType,
    token: '',
    headers: connection.headerNames.map((name) => ({
      key: crypto.randomUUID(),
      name,
      value: '',
      stored: true,
    })),
  };
}

export function toCreateRequest(form: McpServerFormState): CreateMcpConnectionRequest {
  const headers = form.headers.map((row) => ({ name: row.name.trim(), value: row.value }));
  return {
    name: form.name.trim(),
    url: form.url.trim(),
    authType: form.authType,
    ...(form.authType === 'bearer' ? { token: form.token } : {}),
    ...(headers.length > 0 ? { headers } : {}),
  };
}

/**
 * Only what the user typed replaces a secret. The header list is always the complete desired
 * set: a stored row left blank keeps its saved value, and a removed row is simply absent.
 */
export function toUpdateRequest(form: McpServerFormState): UpdateMcpConnectionRequest {
  const url = form.url.trim();
  const headers: McpConnectionHeaderUpdate[] = form.headers.map((row) =>
    row.stored && row.value === ''
      ? { name: row.name }
      : { name: row.name.trim(), value: row.value }
  );
  return {
    name: form.name.trim(),
    authType: form.authType,
    ...(url ? { url } : {}),
    ...(form.authType === 'bearer' && form.token ? { token: form.token } : {}),
    headers,
  };
}
