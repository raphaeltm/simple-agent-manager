type Payload = { message: string };

export function currentRecordShape(raw: string) {
  return JSON.parse(raw) as Record<string, unknown>;
}

export function currentPartialShape(raw: string) {
  return JSON.parse(raw) as Partial<Payload>;
}

export function currentConcreteShape(raw: string) {
  return JSON.parse(raw) as { error?: string; cause?: string };
}

export function nestedTypedAssertion(raw: string) {
  return JSON.parse(raw) as unknown as Payload;
}

export function safeUnknown(raw: string) {
  return JSON.parse(raw) as unknown;
}

export function safeValidated(raw: string, parsePayload: (value: unknown) => Payload) {
  const parsed = JSON.parse(raw) as unknown;
  return parsePayload(parsed);
}

export function aliasNearMiss(raw: string, parse: (value: string) => unknown) {
  return parse(raw) as Payload;
}

export function computedNearMiss(raw: string) {
  return JSON['parse'](raw) as Payload;
}

const stringNearMiss = 'JSON.parse(raw) as Payload';
// JSON.parse(raw) as Payload
