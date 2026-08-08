export type SqlTokenKind = 'word' | 'quotedIdentifier' | 'string' | 'symbol';

export interface SqlToken {
  kind: SqlTokenKind;
  value: string;
  line: number;
  column: number;
}

export interface SqlStatement {
  tokens: SqlToken[];
}

export class SqlParseError extends Error {
  constructor(
    readonly file: string,
    readonly line: number,
    readonly column: number,
    message: string
  ) {
    super(`${file}:${line}:${column}: ${message}`);
    this.name = 'SqlParseError';
  }
}

function isWordCharacter(char: string): boolean {
  return /[A-Za-z0-9_$]/.test(char) || char.charCodeAt(0) > 127;
}

/**
 * Tokenize the SQLite syntax used by D1 migrations while retaining source
 * positions. Comments are whitespace, string contents never become grammar
 * tokens, and quoted identifiers remain distinguishable from keywords.
 */
export function tokenizeSql(sql: string, file: string): SqlToken[] {
  const tokens: SqlToken[] = [];
  let offset = 0;
  let line = 1;
  let column = 1;

  const advance = (): string => {
    const char = sql[offset] ?? '';
    if (char === '\r') {
      offset += sql[offset + 1] === '\n' ? 2 : 1;
      line += 1;
      column = 1;
    } else if (char === '\n') {
      offset += 1;
      line += 1;
      column = 1;
    } else {
      offset += 1;
      column += 1;
    }
    return char;
  };

  const readDelimited = (
    closer: string,
    kind: 'string' | 'quotedIdentifier',
    description: string,
    doubledEscape: boolean
  ): void => {
    const startLine = line;
    const startColumn = column;
    let value = '';
    advance();

    while (offset < sql.length) {
      const char = sql[offset] ?? '';
      if (char === closer) {
        if (doubledEscape && sql[offset + 1] === closer) {
          value += closer;
          advance();
          advance();
          continue;
        }
        advance();
        tokens.push({ kind, value, line: startLine, column: startColumn });
        return;
      }
      value += advance();
    }

    throw new SqlParseError(file, startLine, startColumn, `unterminated ${description}`);
  };

  while (offset < sql.length) {
    const char = sql[offset] ?? '';
    const next = sql[offset + 1] ?? '';

    if (/\s/.test(char)) {
      advance();
      continue;
    }

    if (char === '-' && next === '-') {
      advance();
      advance();
      while (offset < sql.length && sql[offset] !== '\r' && sql[offset] !== '\n') advance();
      continue;
    }

    if (char === '/' && next === '*') {
      const startLine = line;
      const startColumn = column;
      advance();
      advance();
      let closed = false;
      while (offset < sql.length) {
        if (sql[offset] === '*' && sql[offset + 1] === '/') {
          advance();
          advance();
          closed = true;
          break;
        }
        advance();
      }
      if (!closed) {
        throw new SqlParseError(file, startLine, startColumn, 'unterminated block comment');
      }
      continue;
    }

    if (char === "'") {
      readDelimited("'", 'string', 'single-quoted string', true);
      continue;
    }
    if (char === '"') {
      readDelimited('"', 'quotedIdentifier', 'double-quoted identifier', true);
      continue;
    }
    if (char === '`') {
      readDelimited('`', 'quotedIdentifier', 'backtick-quoted identifier', true);
      continue;
    }
    if (char === '[') {
      readDelimited(']', 'quotedIdentifier', 'bracket-quoted identifier', false);
      continue;
    }

    const startLine = line;
    const startColumn = column;
    if (isWordCharacter(char)) {
      let value = '';
      while (offset < sql.length && isWordCharacter(sql[offset] ?? '')) value += advance();
      tokens.push({ kind: 'word', value, line: startLine, column: startColumn });
      continue;
    }

    tokens.push({ kind: 'symbol', value: advance(), line: startLine, column: startColumn });
  }

  return tokens;
}

export function isKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return token?.kind === 'word' && token.value.toLowerCase() === keyword.toLowerCase();
}

export function isIdentifier(token: SqlToken | undefined): token is SqlToken {
  // SQLite accepts single-quoted tokens as identifiers when grammar requires
  // an identifier (a historical compatibility behavior). They remain string
  // tokens elsewhere, so inert SQL text never becomes a keyword.
  return token?.kind === 'word' || token?.kind === 'quotedIdentifier' || token?.kind === 'string';
}

function isCreateTrigger(tokens: SqlToken[]): boolean {
  if (!isKeyword(tokens[0], 'create')) return false;
  if (isKeyword(tokens[1], 'trigger')) return true;
  return (
    (isKeyword(tokens[1], 'temp') || isKeyword(tokens[1], 'temporary')) &&
    isKeyword(tokens[2], 'trigger')
  );
}

/** Split top-level SQL while keeping CREATE TRIGGER BEGIN...END programs intact. */
export function splitSqlStatements(tokens: SqlToken[], file: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  let current: SqlToken[] = [];
  let triggerBody = false;
  let triggerClosed = false;
  let caseDepth = 0;

  const finish = (): void => {
    if (current.length > 0) statements.push({ tokens: current });
    current = [];
    triggerBody = false;
    triggerClosed = false;
    caseDepth = 0;
  };

  for (const token of tokens) {
    if (token.kind === 'symbol' && token.value === ';') {
      if (triggerBody && !triggerClosed) {
        current.push(token);
      } else {
        finish();
      }
      continue;
    }

    current.push(token);
    const previous = current[current.length - 2];
    const isQualifiedIdentifier = previous?.kind === 'symbol' && previous.value === '.';
    if (
      !triggerBody &&
      isCreateTrigger(current) &&
      !isQualifiedIdentifier &&
      isKeyword(token, 'begin')
    ) {
      triggerBody = true;
      continue;
    }
    if (!triggerBody) continue;

    if (!isQualifiedIdentifier && isKeyword(token, 'case')) {
      caseDepth += 1;
    } else if (!isQualifiedIdentifier && isKeyword(token, 'end')) {
      if (caseDepth > 0) caseDepth -= 1;
      else triggerClosed = true;
    }
  }

  if (triggerBody && !triggerClosed) {
    const start = current[0];
    throw new SqlParseError(
      file,
      start?.line ?? 1,
      start?.column ?? 1,
      'unterminated CREATE TRIGGER body'
    );
  }
  finish();
  return statements;
}

/**
 * Return independently executable DML clauses. Ordinary statements have one
 * clause; trigger programs expose each body statement so a later WHERE cannot
 * make an earlier unscoped mutation look safe.
 */
export function logicalSqlStatements(statement: SqlStatement): SqlToken[][] {
  const tokens = statement.tokens;
  if (!isCreateTrigger(tokens)) return [tokens];

  const begin = tokens.findIndex((token) => isKeyword(token, 'begin'));
  if (begin < 0) return [tokens];

  const clauses: SqlToken[][] = [];
  let current: SqlToken[] = [];
  for (let index = begin + 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (isKeyword(token, 'end') && index === tokens.length - 1) break;
    if (token?.kind === 'symbol' && token.value === ';') {
      if (current.length > 0) clauses.push(current);
      current = [];
    } else if (token) {
      current.push(token);
    }
  }
  if (current.length > 0) clauses.push(current);
  return clauses;
}
