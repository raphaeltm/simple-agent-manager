export class MigrationSafetyError extends Error {}
/**
 * Wrangler 4.118 can append a human-readable diagnostic after a valid `--json`
 * response. Keep the migration gate fail-closed for leading garbage and
 * malformed JSON while accepting that documented output shape.
 */
export function parseWranglerJsonOutput(output: string): unknown {
  const trimmedStart = output.trimStart();
  const first = trimmedStart[0];
  if (first !== '[' && first !== '{') {
    throw new MigrationSafetyError('Wrangler D1 output did not begin with JSON');
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  let end = -1;

  for (let index = 0; index < trimmedStart.length; index += 1) {
    const character = trimmedStart[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
    } else if (character === '[' || character === '{') {
      depth += 1;
    } else if (character === ']' || character === '}') {
      depth -= 1;
      if (depth < 0) {
        throw new MigrationSafetyError('Wrangler D1 output contained malformed JSON');
      }
      if (depth === 0) {
        end = index + 1;
        break;
      }
    }
  }

  if (end < 0 || inString || depth !== 0) {
    throw new MigrationSafetyError('Wrangler D1 output contained incomplete JSON');
  }

  return JSON.parse(trimmedStart.slice(0, end)) as unknown;
}

export function parseD1Rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    throw new MigrationSafetyError('Wrangler D1 JSON response was not an array');
  }

  const results = (value[0] as { results?: unknown } | undefined)?.results;
  if (!Array.isArray(results)) {
    throw new MigrationSafetyError('Wrangler D1 JSON response did not include a results array');
  }

  return results as Record<string, unknown>[];
}
export function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
