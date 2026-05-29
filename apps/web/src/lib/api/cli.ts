import { API_URL, request } from './client';

export interface CliVersionInfo {
  available: boolean;
  version: string | null;
  buildDate: string | null;
}

/** Fetch CLI version metadata from the API. */
export async function getCliVersion(): Promise<CliVersionInfo> {
  return request<CliVersionInfo>('/api/cli/version');
}

/** Build a direct download URL for a CLI binary. */
export function getCliDownloadUrl(os: string, arch: string): string {
  return `${API_URL}/api/cli/download?os=${encodeURIComponent(os)}&arch=${encodeURIComponent(arch)}`;
}
