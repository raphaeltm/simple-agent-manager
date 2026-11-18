import * as v from 'valibot';

import { parseRow } from './core';

// =============================================================================
// Migration row schema
// =============================================================================

const MigrationNameSchema = v.object({ name: v.string() });

export function parseMigrationName(row: unknown): string {
  return parseRow(MigrationNameSchema, row, 'migration_name').name;
}

// =============================================================================
// KV meta row schema (used in index.ts for do_meta)
// =============================================================================

const MetaValueSchema = v.object({ value: v.string() });

export function parseMetaValue(row: unknown, context: string): string {
  return parseRow(MetaValueSchema, row, context).value;
}
