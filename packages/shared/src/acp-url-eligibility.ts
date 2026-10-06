import { DEFAULT_ACP_INTERACTION_URL_MAX_CHARS, DEFAULT_ACP_INTERACTION_URL_REDIRECT_DEPTH } from './acp-interactions';

/** Browser navigation only. This function never fetches or follows redirects. */
export function eligibleAcpUrl(raw: string, maxChars = DEFAULT_ACP_INTERACTION_URL_MAX_CHARS,
  redirectDepth = DEFAULT_ACP_INTERACTION_URL_REDIRECT_DEPTH): { host: string } | null {
  return eligibleAcpUrlDepth(raw, 0, maxChars, redirectDepth);
}

function eligibleAcpUrlDepth(raw: string, depth: number, maxChars: number, redirectDepth: number): { host: string } | null {
  if (depth > redirectDepth) return null;
  if (raw.length === 0 || [...raw].length > maxChars || raw.trim() !== raw ||
      raw.includes(';') || raw.includes('\\') || /%(?![0-9a-f]{2})/iu.test(raw)) return null;
  for (const character of raw) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return null;
  }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      (parsed.port && parsed.port !== '443') || parsed.hash || !parsed.hostname.includes('.')) return null;
  const host = parsed.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/u.test(host) || host.includes('..') ||
      host.split('.').some((part) => !part || part.startsWith('-') || part.endsWith('-') || part.startsWith('xn--')) ||
      !/^[a-z]{2,}$/u.test(host.split('.').at(-1) ?? '') ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal')) return null;
  for (const [key, value] of parsed.searchParams) {
    if (/^(redirect|redirect_uri|redirect_url|callback|callback_uri|callback_url|return_to|return_url|return_uri|next|continue)$/iu.test(key)) {
      if (!eligibleAcpUrlDepth(value, depth + 1, maxChars, redirectDepth)) return null;
    }
  }
  return { host };
}
