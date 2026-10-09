import { request } from './client';

export interface ConnectorConnection {
  id: string;
  userId: string;
  clientId: string;
  clientName: string;
  scopes: string[];
  createdAt: string | number;
  lastUsedAt: string | number | null;
  revokedAt: string | number | null;
}
export interface ConnectorClient {
  id: string;
  clientName: string;
  redirectHosts: string[];
  createdAt: string | number;
  blocked: boolean;
}
export interface ConnectorSetting {
  value: boolean | string | number | string[];
  source: string;
  updatedAt: string | null;
  updatedBy: string | null;
}
export type ConnectorSettings = Record<string, ConnectorSetting>;
export const connectorSettings = () =>
  request<{ enabled: boolean; writeEnabled: boolean; url: string }>('/api/connector/settings');
export const connectorConnections = (admin = false, cursor?: string) =>
  request<{ connections: ConnectorConnection[]; nextCursor?: string | null }>(
    `/api/${admin ? 'admin/' : ''}connector/connections${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
  );
export const revokeConnectorConnection = (id: string, admin = false) =>
  request<void>(`/api/${admin ? 'admin/' : ''}connector/connections/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
export const adminConnectorSettings = () =>
  request<{ settings: ConnectorSettings }>('/api/admin/connector/settings');
export const saveConnectorSettings = (values: Record<string, ConnectorSetting['value'] | null>) =>
  request<{ settings: ConnectorSettings }>('/api/admin/connector/settings', {
    method: 'PATCH',
    body: JSON.stringify(values),
  });
export const connectorClients = (cursor?: string) =>
  request<{ clients: ConnectorClient[]; nextCursor?: string | null }>(
    `/api/admin/connector/clients${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`
  );
export const blockConnectorClient = (id: string, blocked: boolean) =>
  request<void>(`/api/admin/connector/clients/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ blocked }),
  });
export interface ConnectorConsent {
  handle: string;
  clientName: string;
  redirectHost: string;
  loopback: boolean;
  scopes: string[];
}
export const getConnectorConsent = (query: string) =>
  request<ConnectorConsent>(`/api/connector/consent?${query}`);
export const decideConnectorConsent = (handle: string, approve: boolean) =>
  request<{ redirectTo: string }>('/api/connector/consent', {
    method: 'POST',
    body: JSON.stringify({ handle, approve }),
  });
