/**
 * Cloudflare Origin CA Certificate
 *
 * Generates a wildcard Origin CA certificate for *.{BASE_DOMAIN} that the
 * VM agent uses to serve HTTPS. Cloudflare's edge validates this cert when
 * proxying requests to origin servers (vm-{id}.{domain}).
 *
 * - 15-year validity (maximum for Origin CA)
 * - RSA-2048 private key (matches JWT key pattern)
 * - Protected from accidental deletion
 * - Cert/key persisted in Pulumi state (encrypted in R2)
 */

import * as cloudflare from "@pulumi/cloudflare";
import * as pulumi from "@pulumi/pulumi";
import * as tls from "@pulumi/tls";

const config = new pulumi.Config();
const baseDomain = config.require("baseDomain");

/**
 * RSA-2048 private key for the Origin CA certificate.
 * The VM agent loads this to serve TLS.
 */
const originCaKey = new tls.PrivateKey(
  "origin-ca-key",
  {
    algorithm: "RSA",
    rsaBits: 2048,
  },
  { protect: true }
);

/**
 * Certificate Signing Request for the Origin CA certificate.
 */
const originCaCsr = new tls.CertRequest("origin-ca-csr", {
  privateKeyPem: originCaKey.privateKeyPem,
  subject: {
    commonName: `*.${baseDomain}`,
    organization: "Simple Agent Manager",
  },
  dnsNames: [`*.${baseDomain}`, baseDomain],
});

/**
 * Cloudflare Origin CA certificate.
 * Valid for 15 years (5475 days). Trusted only by Cloudflare's edge — not
 * by browsers directly — which is the intended use case (orange-clouded DNS).
 */
const originCaCert = new cloudflare.OriginCaCertificate(
  "origin-ca-cert",
  {
    csr: originCaCsr.certRequestPem,
    hostnames: [`*.${baseDomain}`, baseDomain],
    requestType: "origin-rsa",
    requestedValidity: 5475, // 15 years
  },
  { protect: true }
);

// Export as secret outputs
export const originCaCertPem = pulumi.secret(originCaCert.certificate);
export const originCaKeyPem = pulumi.secret(originCaKey.privateKeyPem);
