import { jsonValidator } from '../../src/schemas/_validator';

type CreatePolicyRequest = { name: string };

export async function currentTruePositive(c: { req: { json<T>(): Promise<T> } }) {
  const body = await c.req.json<CreatePolicyRequest>();
  return body.name;
}

export async function multilineTruePositive(context: { req: { json<T>(): Promise<T> } }) {
  const body = await context.req.json<{
    defaultModel: string;
  }>();
  return body.defaultModel;
}

export async function safeUntyped(c: { req: { json(): Promise<unknown> } }) {
  return c.req.json();
}

export async function safeValidatorRoute(app: {
  post(path: string, validator: unknown, handler: unknown): void;
}) {
  app.post(
    '/ok',
    jsonValidator('json', {}),
    async (c: { req: { valid(kind: 'json'): CreatePolicyRequest } }) => {
      return c.req.valid('json');
    }
  );
}

export async function aliasNearMiss(c: { request: { json<T>(): Promise<T> } }) {
  return c.request.json<CreatePolicyRequest>();
}

const stringNearMiss = 'await c.req.json<CreatePolicyRequest>()';
// await c.req.json<CreatePolicyRequest>();
