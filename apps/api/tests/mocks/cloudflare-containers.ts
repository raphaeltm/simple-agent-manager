export class Container<Env = unknown> {
  ctx: DurableObjectState;
  env: Env;
  defaultPort = 8080;
  requiredPorts = [8080];
  sleepAfter = '10m';
  enableInternet = true;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async startAndWaitForPorts(): Promise<void> {}

  async stop(): Promise<void> {}

  async destroy(): Promise<void> {}

  async fetch(request: Request): Promise<Response> {
    return this.containerFetch(request, this.defaultPort);
  }

  async getState(): Promise<{ status: string }> {
    return { status: 'running' };
  }

  containerFetch(_request: Request, _port?: number): Response {
    return new Response('container mock');
  }

  renewActivityTimeout(): void {}

  async schedule(_seconds: number, _callback: string): Promise<void> {}

  async deleteSchedules(_callback: string): Promise<void> {}
}

export function switchPort(request: Request): Request {
  return request;
}
