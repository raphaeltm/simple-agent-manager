import { describe, expect, it, beforeAll } from "vitest";
import { findRegisteredResource, getSecretStatus } from "./setup";

describe("Origin CA Resources", () => {
  let originCaModule: typeof import("../resources/origin-ca");

  beforeAll(async () => {
    originCaModule = await import("../resources/origin-ca");
  });

  it("protects the RSA-2048 Origin CA private key", () => {
    const privateKey = findRegisteredResource(
      "origin-ca-key",
      "tls:index/privateKey:PrivateKey"
    );

    expect(privateKey.inputs).toMatchObject({
      algorithm: "RSA",
      rsaBits: 2048,
    });
    expect(privateKey.options.protect).toBe(true);
  });

  it("requests a CSR for base and VM wildcard hostnames", () => {
    const csr = findRegisteredResource(
      "origin-ca-csr",
      "tls:index/certRequest:CertRequest"
    );

    expect(csr.inputs.subject).toMatchObject({
      commonName: "*.example.com",
    });
    expect(csr.inputs.dnsNames).toEqual(
      expect.arrayContaining(["*.example.com", "*.vm.example.com", "example.com"])
    );
  });

  it("requests an origin-rsa certificate for 15 years without protect", () => {
    const cert = findRegisteredResource(
      "origin-ca-cert",
      "cloudflare:index/originCaCertificate:OriginCaCertificate"
    );

    expect(cert.inputs).toMatchObject({
      hostnames: ["*.example.com", "*.vm.example.com", "example.com"],
      requestType: "origin-rsa",
      requestedValidity: 5475,
    });
    expect(cert.options.protect).toBeUndefined();
  });

  it("exports Origin CA certificate and key as Pulumi secrets", async () => {
    await expect(getSecretStatus(originCaModule.originCaCertPem)).resolves.toBe(true);
    await expect(getSecretStatus(originCaModule.originCaKeyPem)).resolves.toBe(true);
  });
});
