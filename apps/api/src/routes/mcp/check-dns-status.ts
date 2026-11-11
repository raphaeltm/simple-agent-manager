/**
 * MCP `check_dns_status`: does the workspace's own URL (`https://ws-<id>.<BASE_DOMAIN>`) answer?
 *
 * The workspace (a node the user, or an agent running in it, controls) answers this request, so
 * the request is guarded:
 * - Only redirects that stay on the workspace's own origin are followed, through the guarded
 *   fetch (each hop re-checked, at most `outbound.maxRedirects`). httpStatus is then the final
 *   status, as before the guard. A redirect to any other origin is reported with its 3xx status
 *   and never requested: following it would let the workspace point the control plane at
 *   arbitrary hosts and read back their status, and would report a third party's health as the
 *   workspace's.
 * - A private-domain install (BASE_DOMAIN such as `sam.lan`, `*.internal`, a single label) has a
 *   private workspace host by design, so the first hop may be private exactly when it is; hops
 *   stay on that origin anyway. Forbidden hosts (metadata, link-local) are refused regardless.
 * - Errors are reported as fixed categories, never as raw error text, which could otherwise tell
 *   a caller which ports and addresses answer.
 */
import type { Env } from '../../env';
import { classifyHost, guardedFetch, OutboundRequestRefusedError } from '../../lib/network-hosts';
import { parsePositiveInt } from '../../lib/route-helpers';
import { resolveOutboundMaxRedirects } from '../../services/outbound-fetch-settings';
import { type JsonRpcResponse, jsonRpcSuccess, type McpTokenData } from './_helpers';
import { requireWorkspace } from './workspace-tools';

/** Timeout for DNS check calls. Override via WORKSPACE_TOOL_DNS_TIMEOUT_MS. */
const DEFAULT_DNS_CHECK_TIMEOUT_MS = 10_000;

function getDnsCheckTimeout(env: Env): number {
  return parsePositiveInt(env.WORKSPACE_TOOL_DNS_TIMEOUT_MS, DEFAULT_DNS_CHECK_TIMEOUT_MS);
}

/** A hop that left the workspace's own origin; it is reported, never requested. */
class CrossOriginRedirectError extends Error {
  constructor() {
    super('redirect to another origin');
    this.name = 'CrossOriginRedirectError';
  }
}

type DnsErrorCategory = 'timeout' | 'tls' | 'network';

/** The fixed category for a fetch failure; the error text itself is never returned. */
function errorCategory(error: unknown): DnsErrorCategory {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return 'timeout';
  }
  const cause = error instanceof Error ? error.cause : undefined;
  const text = `${String(error)} ${cause instanceof Error ? cause.message : String(cause ?? '')}`;
  return /SSL|TLS|certificate|CERT_/i.test(text) ? 'tls' : 'network';
}

function textResult(requestId: string | number | null, body: Record<string, unknown>) {
  return jsonRpcSuccess(requestId, {
    content: [{ type: 'text', text: JSON.stringify(body, null, 2) }],
  });
}

function failureResult(
  requestId: string | number | null,
  base: { hostname: string; workspaceUrl: string },
  error: unknown,
  redirectStatus: number | null
): JsonRpcResponse {
  if (error instanceof CrossOriginRedirectError) {
    return textResult(requestId, {
      ...base,
      dnsResolved: true,
      tlsValid: true,
      httpStatus: redirectStatus,
      status: 'redirect_cross_origin',
      note: 'The workspace answered with a redirect to another origin; SAM does not follow it.',
    });
  }
  if (error instanceof OutboundRequestRefusedError) {
    return textResult(requestId, {
      ...base,
      dnsResolved: true,
      tlsValid: true,
      status: 'redirect_refused',
      refusal: error.reason,
      note: 'The workspace answered with a redirect SAM does not follow (a refused address, or too many hops).',
    });
  }
  const category = errorCategory(error);
  return textResult(requestId, {
    ...base,
    dnsResolved: category === 'tls', // a TLS error means DNS resolved but the cert failed
    tlsValid: false,
    status:
      category === 'tls' ? 'tls_error' : category === 'timeout' ? 'timeout' : 'dns_not_resolved',
    error: category,
  });
}

export async function handleCheckDnsStatus(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const err = requireWorkspace(requestId, tokenData);
  if (err) return err;

  const hostname = `ws-${tokenData.workspaceId}.${env.BASE_DOMAIN}`;
  const workspaceUrl = `https://${hostname}`;
  const origin = new URL(workspaceUrl).origin;
  const base = { hostname, workspaceUrl };
  let lastStatus: number | null = null;

  try {
    // Note: this only confirms edge reachability, not VM agent health.
    const res = await guardedFetch(
      workspaceUrl,
      { method: 'HEAD', signal: AbortSignal.timeout(getDnsCheckTimeout(env)) },
      {
        allowPrivateNetwork: classifyHost(hostname) === 'private',
        maxRedirects: await resolveOutboundMaxRedirects(env),
        validateUrl: (url) => {
          if (url.origin !== origin) throw new CrossOriginRedirectError();
        },
        // Records each hop's status so a refused cross-origin redirect reports its 3xx. Every
        // URL reaching it has passed guardedFetch's host, scheme and origin checks.
        fetchFn: async (url, init) => {
          const hop = await fetch(url, init);
          lastStatus = hop.status;
          return hop;
        },
      }
    );
    return textResult(requestId, {
      ...base,
      dnsResolved: true,
      tlsValid: true,
      httpStatus: res.status,
      note: 'Confirms edge reachability of the workspace URL. Does not verify VM agent health.',
    });
  } catch (e) {
    return failureResult(requestId, base, e, lastStatus);
  }
}
