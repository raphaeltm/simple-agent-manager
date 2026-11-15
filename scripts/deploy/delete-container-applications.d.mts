export function installationApplications<T extends { name?: unknown }>(
  applications: T[],
  apiWorker: string,
  stack: string
): T[];
export function deleteContainerApplications(input: {
  accountId: string | undefined;
  token: string | undefined;
  apiWorker: string | undefined;
  stack: string | undefined;
  dryRun?: boolean;
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}): Promise<string[]>;
