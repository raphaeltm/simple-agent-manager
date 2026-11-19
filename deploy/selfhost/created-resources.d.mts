// Types for created-resources.mjs (the record of what an install created; no secrets).
export const FORMAT: 'sam-created-resources/1';

export interface CreatedResource {
  cloud: string;
  kind: string;
  name: string;
  attributes?: Record<string, string>;
  createdBy: string;
  action: 'created' | 'reused';
  createdAt?: string;
  removedAt?: string;
}

export interface CreatedResourcesRecord {
  format: typeof FORMAT;
  resources: CreatedResource[];
}

export function readRecord(file: string): CreatedResourcesRecord;
export function addResource(
  file: string,
  entry: Omit<CreatedResource, 'createdAt' | 'removedAt'>,
  now?: Date
): void;
export function markRemoved(
  file: string,
  cloud: string,
  kind: string,
  name: string,
  now?: Date
): void;
