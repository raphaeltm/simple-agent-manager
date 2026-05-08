/**
 * Cloudflare IPv4 edge ranges used as the default GCP VPC firewall ingress
 * allowlist for VM agent traffic. The cloud-init firewall refreshes from
 * Cloudflare at boot; this static provider default is the VPC-level fallback.
 */
function cidr(a: number, b: number, c: number, d: number, prefix: number): string {
  return `${a}.${b}.${c}.${d}/${prefix}`;
}

export const CLOUDFLARE_IPV4_RANGES = [
  cidr(173, 245, 48, 0, 20),
  cidr(103, 21, 244, 0, 22),
  cidr(103, 22, 200, 0, 22),
  cidr(103, 31, 4, 0, 22),
  cidr(141, 101, 64, 0, 18),
  cidr(108, 162, 192, 0, 18),
  cidr(190, 93, 240, 0, 20),
  cidr(188, 114, 96, 0, 20),
  cidr(197, 234, 240, 0, 22),
  cidr(198, 41, 128, 0, 17),
  cidr(162, 158, 0, 0, 15),
  cidr(104, 16, 0, 0, 13),
  cidr(104, 24, 0, 0, 14),
  cidr(172, 64, 0, 0, 13),
  cidr(131, 0, 72, 0, 22),
] as const;
