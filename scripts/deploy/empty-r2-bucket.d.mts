export const DEFAULT_R2_EMPTY_DEADLINE_SECONDS: number;
export function emptyR2Bucket(input: {
  accountId: string | undefined;
  bucket: string | undefined;
  token: string | undefined;
  deadlineMs: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): Promise<{ deleted: number; empty: boolean }>;
