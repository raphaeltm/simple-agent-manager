import type {
  ReportIssueConfig,
  ReportIssueRequest,
  ReportIssueResponse,
} from '@simple-agent-manager/shared';

import { request } from './client';

export async function getReportIssueConfig(): Promise<ReportIssueConfig> {
  return request<ReportIssueConfig>('/api/report-issue/config');
}

export async function submitReportIssue(
  data: ReportIssueRequest,
): Promise<ReportIssueResponse> {
  return request<ReportIssueResponse>('/api/report-issue', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}
