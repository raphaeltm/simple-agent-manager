import { ApiClientError } from './api';

const API_URL = (() => {
  const url = import.meta.env.VITE_API_URL;
  if (!url && import.meta.env.PROD) {
    throw new Error('VITE_API_URL is required in production builds');
  }
  return url || 'http://localhost:8787';
})();

async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  const contentType = response.headers.get('content-type');
  const data = contentType?.includes('application/json')
    ? await response.json()
    : {};

  if (!response.ok) {
    const code = typeof data?.error === 'string' ? data.error : 'UNKNOWN_ERROR';
    const message = typeof data?.message === 'string' ? data.message : 'Request failed';
    throw new ApiClientError(code, message, response.status);
  }

  return data as T;
}

export interface UIStandard {
  id: string;
  version: string;
  status: 'draft' | 'review' | 'active' | 'deprecated';
  name: string;
  visualDirection: string;
  mobileFirstRulesRef: string;
  accessibilityRulesRef: string;
  ownerRole: string;
}

export interface ComponentDefinition {
  id: string;
  standardId: string;
  name: string;
  category: 'input' | 'navigation' | 'feedback' | 'layout' | 'display' | 'overlay';
  supportedSurfaces: Array<'control-plane' | 'agent-ui'>;
  requiredStates: string[];
  usageGuidance: string;
  accessibilityNotes: string;
  mobileBehavior: string;
  desktopBehavior: string;
  status: 'draft' | 'ready' | 'deprecated';
}

export async function getActiveUiStandard(): Promise<UIStandard> {
  return request<UIStandard>('/api/ui-governance/standards/active');
}

export async function upsertUiStandard(version: string, input: Omit<UIStandard, 'id' | 'version'>): Promise<UIStandard> {
  return request<UIStandard>(`/api/ui-governance/standards/${version}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function listComponentDefinitions(
  filters: { surface?: 'control-plane' | 'agent-ui'; status?: 'draft' | 'ready' | 'deprecated' } = {}
): Promise<{ items: ComponentDefinition[] }> {
  const params = new URLSearchParams();
  if (filters.surface) params.set('surface', filters.surface);
  if (filters.status) params.set('status', filters.status);
  const query = params.toString() ? `?${params.toString()}` : '';
  return request<{ items: ComponentDefinition[] }>(`/api/ui-governance/components${query}`);
}

export async function createComponentDefinition(input: Omit<ComponentDefinition, 'id'>): Promise<ComponentDefinition> {
  return request<ComponentDefinition>('/api/ui-governance/components', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getComponentDefinition(componentId: string): Promise<ComponentDefinition> {
  return request<ComponentDefinition>(`/api/ui-governance/components/${componentId}`);
}

export async function updateComponentDefinition(
  componentId: string,
  input: Partial<Omit<ComponentDefinition, 'id' | 'standardId' | 'name' | 'category'>>
): Promise<ComponentDefinition> {
  return request<ComponentDefinition>(`/api/ui-governance/components/${componentId}`, {
    method: 'PUT',
    body: JSON.stringify(input),
  });
}

export async function createComplianceRun(input: {
  standardId: string;
  checklistVersion: string;
  authorType: 'human' | 'agent';
  changeRef: string;
}) {
  return request('/api/ui-governance/compliance-runs', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function getComplianceRun(runId: string) {
  return request(`/api/ui-governance/compliance-runs/${runId}`);
}

export async function createExceptionRequest(input: {
  standardId: string;
  requestedBy: string;
  rationale: string;
  scope: string;
  expirationDate: string;
}) {
  return request('/api/ui-governance/exceptions', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function createMigrationWorkItem(input: {
  standardId: string;
  surface: 'control-plane' | 'agent-ui';
  targetRef: string;
  priority: 'high' | 'medium' | 'low';
  status: 'backlog' | 'planned' | 'in-progress' | 'completed' | 'verified';
  owner: string;
  dueMilestone?: string;
  notes?: string;
}) {
  return request('/api/ui-governance/migration-items', {
    method: 'POST',
    body: JSON.stringify(input),
  });
}

export async function updateMigrationWorkItem(
  itemId: string,
  input: { status: 'backlog' | 'planned' | 'in-progress' | 'completed' | 'verified'; owner?: string; notes?: string }
) {
  return request(`/api/ui-governance/migration-items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  });
}

export async function getActiveAgentInstructions() {
  return request('/api/ui-governance/agent-instructions/active');
}
