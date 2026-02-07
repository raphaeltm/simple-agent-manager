import { errors } from '../middleware/error';
import type {
  ComponentDefinitionCreateInput,
  ComponentDefinitionUpdateInput,
  ComplianceRunCreateInput,
  ExceptionRequestCreateInput,
  MigrationWorkItemCreateInput,
  UIStandardUpsert,
} from '../services/ui-governance';

function ensureRecord(value: unknown, message = 'Invalid request body'): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw errors.badRequest(message);
  }
  return value as Record<string, unknown>;
}

function ensureString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw errors.badRequest(`${field} is required`);
  }
  return value.trim();
}

function ensureOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw errors.badRequest('Expected a string value');
  }
  return value;
}

function ensureStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw errors.badRequest(`${field} must be an array of strings`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function ensureEnum<T extends string>(value: unknown, field: string, allowed: T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw errors.badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function validateStandardUpsert(body: unknown): UIStandardUpsert {
  const payload = ensureRecord(body);
  return {
    status: ensureEnum(payload.status, 'status', ['draft', 'review', 'active', 'deprecated']),
    name: ensureString(payload.name, 'name'),
    visualDirection: ensureString(payload.visualDirection, 'visualDirection'),
    mobileFirstRulesRef: ensureString(payload.mobileFirstRulesRef, 'mobileFirstRulesRef'),
    accessibilityRulesRef: ensureString(payload.accessibilityRulesRef, 'accessibilityRulesRef'),
    ownerRole: ensureString(payload.ownerRole, 'ownerRole'),
  };
}

export function validateComponentDefinitionCreate(body: unknown): ComponentDefinitionCreateInput {
  const payload = ensureRecord(body);
  return {
    standardId: ensureString(payload.standardId, 'standardId'),
    name: ensureString(payload.name, 'name'),
    category: ensureEnum(payload.category, 'category', ['input', 'navigation', 'feedback', 'layout', 'display', 'overlay']),
    supportedSurfaces: ensureStringArray(payload.supportedSurfaces, 'supportedSurfaces'),
    requiredStates: ensureStringArray(payload.requiredStates, 'requiredStates'),
    usageGuidance: ensureString(payload.usageGuidance, 'usageGuidance'),
    accessibilityNotes: ensureString(payload.accessibilityNotes, 'accessibilityNotes'),
    mobileBehavior: ensureString(payload.mobileBehavior, 'mobileBehavior'),
    desktopBehavior: ensureString(payload.desktopBehavior, 'desktopBehavior'),
    status: ensureEnum(payload.status, 'status', ['draft', 'ready', 'deprecated']),
  };
}

export function validateComponentDefinitionUpdate(body: unknown): ComponentDefinitionUpdateInput {
  const payload = ensureRecord(body);
  return {
    supportedSurfaces: payload.supportedSurfaces !== undefined
      ? ensureStringArray(payload.supportedSurfaces, 'supportedSurfaces')
      : undefined,
    requiredStates: payload.requiredStates !== undefined
      ? ensureStringArray(payload.requiredStates, 'requiredStates')
      : undefined,
    usageGuidance: ensureOptionalString(payload.usageGuidance),
    accessibilityNotes: ensureOptionalString(payload.accessibilityNotes),
    mobileBehavior: ensureOptionalString(payload.mobileBehavior),
    desktopBehavior: ensureOptionalString(payload.desktopBehavior),
    status: payload.status !== undefined
      ? ensureEnum(payload.status, 'status', ['draft', 'ready', 'deprecated'])
      : undefined,
  };
}

export function validateComplianceRunCreate(body: unknown): ComplianceRunCreateInput {
  const payload = ensureRecord(body);
  return {
    standardId: ensureString(payload.standardId, 'standardId'),
    checklistVersion: ensureString(payload.checklistVersion, 'checklistVersion'),
    authorType: ensureEnum(payload.authorType, 'authorType', ['human', 'agent']),
    changeRef: ensureString(payload.changeRef, 'changeRef'),
  };
}

export function validateExceptionRequestCreate(body: unknown): ExceptionRequestCreateInput {
  const payload = ensureRecord(body);
  return {
    standardId: ensureString(payload.standardId, 'standardId'),
    requestedBy: ensureString(payload.requestedBy, 'requestedBy'),
    rationale: ensureString(payload.rationale, 'rationale'),
    scope: ensureString(payload.scope, 'scope'),
    expirationDate: ensureString(payload.expirationDate, 'expirationDate'),
  };
}

export function validateMigrationWorkItemCreate(body: unknown): MigrationWorkItemCreateInput {
  const payload = ensureRecord(body);
  return {
    standardId: ensureString(payload.standardId, 'standardId'),
    surface: ensureEnum(payload.surface, 'surface', ['control-plane', 'agent-ui']),
    targetRef: ensureString(payload.targetRef, 'targetRef'),
    priority: ensureEnum(payload.priority, 'priority', ['high', 'medium', 'low']),
    status: ensureEnum(payload.status, 'status', ['backlog', 'planned', 'in-progress', 'completed', 'verified']),
    owner: ensureString(payload.owner, 'owner'),
    dueMilestone: ensureOptionalString(payload.dueMilestone),
    notes: ensureOptionalString(payload.notes),
  };
}

export function validateMigrationWorkItemPatch(body: unknown): {
  status: 'backlog' | 'planned' | 'in-progress' | 'completed' | 'verified';
  owner?: string;
  notes?: string;
} {
  const payload = ensureRecord(body);
  return {
    status: ensureEnum(payload.status, 'status', ['backlog', 'planned', 'in-progress', 'completed', 'verified']),
    owner: ensureOptionalString(payload.owner),
    notes: ensureOptionalString(payload.notes),
  };
}
