/**
 * Report an Issue types — creates draft Ideas in a feedback project
 * with optional consent-gated technical references.
 */

export interface ReportIssueRefs {
  sessionId?: string;
  taskId?: string;
  nodeId?: string;
  errorId?: string;
  diagnosisId?: string;
}

export interface ReportIssueRequest {
  title: string;
  description: string;
  consentToAttachRefs: boolean;
  refs?: ReportIssueRefs;
}

export interface ReportIssueResponse {
  ideaId: string;
  status: 'draft';
  refsAttached: boolean;
  attachedRefKeys: string[];
  message: string;
}

export interface ReportIssueConfig {
  enabled: boolean;
}
