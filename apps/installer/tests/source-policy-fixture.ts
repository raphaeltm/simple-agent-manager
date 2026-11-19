import { readFileSync } from 'node:fs';

export const supportedProtocol = JSON.parse(
  readFileSync(new URL('../../../scripts/deploy/installer-protocol.json', import.meta.url), 'utf8')
) as Record<string, unknown>;
export async function supportedSourceFetch(
  input: string | URL | Request,
  init?: RequestInit
): Promise<Response> {
  const url = String(input);
  if (url.includes('/compare/'))
    return Response.json({ status: 'ahead', ahead_by: 1, behind_by: 0, commits: [] });
  if (url.endsWith('/scripts/deploy/installer-protocol.json'))
    return Response.json(supportedProtocol);
  if (url.startsWith('https://raw.githubusercontent.com/') && init?.method === 'HEAD')
    return new Response(null, { status: 200 });
  throw new Error('Unexpected public source request');
}
