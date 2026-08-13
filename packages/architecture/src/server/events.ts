import type { ServerResponse } from 'node:http';

export type ArchitectureEventName =
  | 'architecture:connected'
  | 'architecture:model'
  | 'architecture:threads'
  | 'architecture:invalid';

interface Client {
  id: number;
  response: ServerResponse;
}

export class EventHub {
  private clients = new Map<number, Client>();
  private nextClientId = 1;

  connect(response: ServerResponse): () => void {
    const id = this.nextClientId;
    this.nextClientId += 1;
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');
    this.clients.set(id, { id, response });
    this.publish('architecture:connected', { id });
    return () => {
      this.clients.delete(id);
    };
  }

  publish(name: ArchitectureEventName, data: unknown): void {
    const payload = JSON.stringify({ event: name, data });
    for (const client of this.clients.values()) {
      client.response.write(`event: ${name}\n`);
      client.response.write(`data: ${payload}\n\n`);
    }
  }

  close(): void {
    for (const client of this.clients.values()) client.response.end();
    this.clients.clear();
  }
}
