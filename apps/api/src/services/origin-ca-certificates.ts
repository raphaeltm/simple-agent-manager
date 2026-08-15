import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';

const CLOUDFLARE_ORIGIN_CA_CERTIFICATES_URL = 'https://api.cloudflare.com/client/v4/certificates';
const DEFAULT_ORIGIN_CA_CERT_VALIDITY_DAYS = 7;
const ALLOWED_ORIGIN_CA_VALIDITY_DAYS = new Set([7, 30, 90, 365, 730, 1095, 5475]);
const CSR_PEM_RE =
  /^-----BEGIN CERTIFICATE REQUEST-----\n[A-Za-z0-9+/= \n\r]+\n-----END CERTIFICATE REQUEST-----$/;

// Only the fields this module reads from Cloudflare's Origin CA response are
// validated. All are optional here (rather than mirroring Cloudflare's own
// required/optional split) because the code below already treats a missing
// `success`/`certificate` as a graceful "issuance failed" outcome instead of
// crashing — the schema preserves that tolerance instead of turning a
// partially-shaped response into a thrown validation error.
const cloudflareOriginCaResponseSchema = v.object({
  success: v.optional(v.boolean()),
  errors: v.optional(
    v.array(
      v.object({
        message: v.optional(v.string()),
        code: v.optional(v.number()),
      })
    )
  ),
  result: v.optional(
    v.object({
      certificate: v.optional(v.string()),
      id: v.optional(v.string()),
      expires_on: v.optional(v.string()),
    })
  ),
});

export interface IssueNodeOriginCertificateResult {
  certificate: string;
  certificateId?: string;
  expiresOn?: string;
  hostnames: string[];
  requestedValidity: number;
}

export async function issueNodeOriginCertificate(
  env: Env,
  csr: string,
  fetchImpl: typeof fetch = fetch
): Promise<IssueNodeOriginCertificateResult> {
  const normalizedCsr = normalizeCsr(csr);
  if (!CSR_PEM_RE.test(normalizedCsr)) {
    throw new Error('Invalid Origin CA CSR PEM');
  }

  if (!env.CF_API_TOKEN) {
    throw new Error('CF_API_TOKEN is required to issue node Origin CA certificates');
  }

  const hostnames = buildOriginCaHostnames(env.BASE_DOMAIN);
  const requestedValidity = resolveOriginCaValidityDays(env.ORIGIN_CA_CERT_VALIDITY_DAYS);
  const response = await fetchImpl(CLOUDFLARE_ORIGIN_CA_CERTIFICATES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      csr: normalizedCsr,
      hostnames,
      request_type: 'origin-rsa',
      requested_validity: requestedValidity,
    }),
  });

  let payload: v.InferOutput<typeof cloudflareOriginCaResponseSchema>;
  try {
    payload = await readResponseJson(
      response,
      cloudflareOriginCaResponseSchema,
      'origin-ca.issue_certificate'
    );
  } catch {
    throw new Error(`Cloudflare Origin CA returned non-JSON response (${response.status})`);
  }

  const certificate = payload.result?.certificate;
  if (!response.ok || !payload.success || !certificate) {
    const apiMessage = payload.errors
      ?.map((err) => err.message)
      .filter(Boolean)
      .join('; ');
    throw new Error(
      `Cloudflare Origin CA certificate issuance failed (${response.status})${apiMessage ? `: ${apiMessage}` : ''}`
    );
  }

  return {
    certificate: normalizeCertificate(certificate),
    certificateId: payload.result?.id,
    expiresOn: payload.result?.expires_on,
    hostnames,
    requestedValidity,
  };
}

export function buildOriginCaHostnames(baseDomain: string): string[] {
  const domain = baseDomain.trim().toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) {
    throw new Error('BASE_DOMAIN must be a valid DNS name for Origin CA hostnames');
  }
  return [`*.${domain}`, `*.vm.${domain}`, domain];
}

export function resolveOriginCaValidityDays(value: string | undefined): number {
  if (!value) return DEFAULT_ORIGIN_CA_CERT_VALIDITY_DAYS;

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || !ALLOWED_ORIGIN_CA_VALIDITY_DAYS.has(parsed)) {
    throw new Error(
      `ORIGIN_CA_CERT_VALIDITY_DAYS must be one of ${Array.from(ALLOWED_ORIGIN_CA_VALIDITY_DAYS).join(', ')}`
    );
  }
  return parsed;
}

function normalizeCsr(csr: string): string {
  return csr.trim().replace(/\r\n/g, '\n');
}

function normalizeCertificate(certificate: string): string {
  return certificate.trim().replace(/\r\n/g, '\n') + '\n';
}
