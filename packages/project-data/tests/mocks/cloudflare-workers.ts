/** Node-only import seam for `cloudflare:workers`; Durable Object behaviour is tested in workerd. */
export class DurableObject {
  constructor(
    public ctx?: unknown,
    public env?: unknown
  ) {}
}
