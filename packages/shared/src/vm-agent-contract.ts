/**
 * VM Agent Contract Types
 *
 * Formal type definitions and Zod schemas for ALL request/response payloads
 * between the control plane (TypeScript API on Cloudflare Workers) and the
 * VM agent (Go on Hetzner VMs).
 *
 * These schemas serve as the single source of truth for the HTTP boundary
 * and can validate payloads at runtime on both sides.
 */

import { z } from 'zod';

// =============================================================================
// Shared Enums & Primitives
// =============================================================================

export const WorkspaceStatusSchema = z.enum([
  'creating',
  'running',
  'recovery',
  'stopped',
  'error',
]);

export const MessageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);

// =============================================================================
// Standardized Error Response
// =============================================================================

export const ErrorResponseSchema = z.object({
  error: z.string(),
  message: z.string().optional(),
});

export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

// =============================================================================
// Control Plane -> VM Agent: GET /health
// =============================================================================

export const HealthWorkspaceSummarySchema = z.object({
  id: z.string(),
  status: z.string(),
  sessions: z.number(),
});

export const HealthResponseSchema = z.object({
  status: z.literal('healthy'),
  nodeId: z.string(),
  activeWorkspaces: z.number(),
  workspaces: z.array(HealthWorkspaceSummarySchema),
  sessions: z.number(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;

// =============================================================================
// Control Plane -> VM Agent: POST /workspaces
// =============================================================================

export const CreateWorkspaceAgentRequestSchema = z.object({
  workspaceId: z.string().min(1),
  repository: z.string(),
  branch: z.string(),
  callbackToken: z.string().optional(),
  gitUserName: z.string().nullish(),
  gitUserEmail: z.string().nullish(),
  githubId: z.string().nullish(),
});

export type CreateWorkspaceAgentRequest = z.infer<typeof CreateWorkspaceAgentRequestSchema>;

export const CreateWorkspaceAgentResponseSchema = z.object({
  workspaceId: z.string(),
  status: z.literal('creating'),
});

export type CreateWorkspaceAgentResponse = z.infer<typeof CreateWorkspaceAgentResponseSchema>;

// =============================================================================
// Control Plane -> VM Agent: DELETE /workspaces/:id
// =============================================================================

export const DeleteWorkspaceAgentResponseSchema = z.object({
  success: z.boolean(),
});

export type DeleteWorkspaceAgentResponse = z.infer<typeof DeleteWorkspaceAgentResponseSchema>;

// =============================================================================
// Control Plane -> VM Agent: POST /workspaces/:id/agent-sessions
// =============================================================================

export const CreateAgentSessionAgentRequestSchema = z.object({
  sessionId: z.string().min(1),
  label: z.string().nullable(),
});

export type CreateAgentSessionAgentRequest = z.infer<typeof CreateAgentSessionAgentRequestSchema>;

export const AgentSessionResponseSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  status: z.string(),
  label: z.string().nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  stoppedAt: z.string().nullable().optional(),
  suspendedAt: z.string().nullable().optional(),
  errorMessage: z.string().nullable().optional(),
  acpSessionId: z.string().optional(),
  agentType: z.string().optional(),
});

export type AgentSessionAgentResponse = z.infer<typeof AgentSessionResponseSchema>;

// =============================================================================
// VM Agent -> Control Plane (Callbacks):
// POST /api/workspaces/:id/ready
// =============================================================================

export const WorkspaceReadyRequestSchema = z.object({
  status: z.enum(['running', 'recovery']).optional(),
});

export type WorkspaceReadyRequest = z.infer<typeof WorkspaceReadyRequestSchema>;

export const WorkspaceReadyResponseSchema = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
});

export type WorkspaceReadyResponse = z.infer<typeof WorkspaceReadyResponseSchema>;

// =============================================================================
// VM Agent -> Control Plane (Callbacks):
// POST /api/workspaces/:id/provisioning-failed
// =============================================================================

export const ProvisioningFailedRequestSchema = z.object({
  errorMessage: z.string().optional(),
});

export type ProvisioningFailedRequest = z.infer<typeof ProvisioningFailedRequestSchema>;

export const ProvisioningFailedResponseSchema = z.object({
  success: z.boolean(),
  reason: z.string().optional(),
});

export type ProvisioningFailedResponse = z.infer<typeof ProvisioningFailedResponseSchema>;

// =============================================================================
// VM Agent -> Control Plane (Callbacks):
// POST /api/workspaces/:id/messages
// =============================================================================

export const PersistMessageItemSchema = z.object({
  messageId: z.string().min(1),
  sessionId: z.string().min(1),
  role: MessageRoleSchema,
  content: z.string().min(1),
  toolMetadata: z.string().nullable().optional(),
  timestamp: z.string().min(1),
});

export type PersistMessageItemContract = z.infer<typeof PersistMessageItemSchema>;

export const PersistMessageBatchRequestSchema = z.object({
  messages: z.array(PersistMessageItemSchema).min(1).max(100),
});

export type PersistMessageBatchRequestContract = z.infer<typeof PersistMessageBatchRequestSchema>;

export const PersistMessageBatchResponseSchema = z.object({
  persisted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});

export type PersistMessageBatchResponseContract = z.infer<typeof PersistMessageBatchResponseSchema>;

// =============================================================================
// JWT Token Claims
// =============================================================================

export const CallbackTokenClaimsSchema = z.object({
  workspace: z.string(),
  type: z.literal('callback'),
  iss: z.string(),
  sub: z.string(),
  aud: z.literal('workspace-callback'),
  exp: z.number(),
  iat: z.number(),
});

export type CallbackTokenClaims = z.infer<typeof CallbackTokenClaimsSchema>;

export const NodeManagementTokenClaimsSchema = z.object({
  type: z.literal('node-management'),
  node: z.string(),
  workspace: z.string().optional(),
  iss: z.string(),
  sub: z.string(),
  aud: z.literal('node-management'),
  exp: z.number(),
  iat: z.number(),
});

export type NodeManagementTokenClaims = z.infer<typeof NodeManagementTokenClaimsSchema>;

// =============================================================================
// Contract Constants
// =============================================================================

/** Maximum messages per batch */
export const MAX_BATCH_SIZE = 100;

/** Default callback token expiry in milliseconds (24 hours) */
export const DEFAULT_CALLBACK_TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000;

/** Default node management token expiry in milliseconds (1 hour) */
export const DEFAULT_NODE_MANAGEMENT_TOKEN_EXPIRY_MS = 60 * 60 * 1000;

/** JWT algorithm used for all tokens */
export const JWT_ALGORITHM = 'RS256' as const;

/** Audience values for token types */
export const JWT_AUDIENCES = {
  terminal: 'workspace-terminal',
  callback: 'workspace-callback',
  nodeManagement: 'node-management',
} as const;
