/** Node-only import seam; Worker suites exercise the real runtime classes. */
export class WorkerEntrypoint {
  constructor(
    public ctx?: unknown,
    public env?: unknown
  ) {}
}
export class DurableObject {
  constructor(
    public ctx?: unknown,
    public env?: unknown
  ) {}
}
