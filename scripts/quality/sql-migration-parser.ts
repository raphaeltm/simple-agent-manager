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

interface TokenizerState {
  sql: string;
  file: string;
  tokens: SqlToken[];
  offset: number;
  line: number;
  column: number;
}

function advance(state: TokenizerState): string {
  const char = state.sql[state.offset] ?? '';
  if (char === '\r') {
    state.offset += state.sql[state.offset + 1] === '\n' ? 2 : 1;
    state.line += 1;
    state.column = 1;
  } else if (char === '\n') {
    state.offset += 1;
    state.line += 1;
    state.column = 1;
  } else {
    state.offset += 1;
    state.column += 1;
  }
  return char;
}

function readDelimited(
  state: TokenizerState,
  closer: string,
  kind: 'string' | 'quotedIdentifier',
  description: string,
  doubledEscape: boolean
): void {
  const { line, column } = state;
  let value = '';
  advance(state);
  while (state.offset < state.sql.length) {
    const char = state.sql[state.offset] ?? '';
    if (char !== closer) {
      value += advance(state);
      continue;
    }
    if (doubledEscape && state.sql[state.offset + 1] === closer) {
      value += closer;
      advance(state);
      advance(state);
      continue;
    }
    advance(state);
    state.tokens.push({ kind, value, line, column });
    return;
  }
  throw new SqlParseError(state.file, line, column, `unterminated ${description}`);
}

function skipBlockComment(state: TokenizerState): void {
  const { line, column } = state;
  advance(state);
  advance(state);
  while (state.offset < state.sql.length) {
    if (state.sql[state.offset] === '*' && state.sql[state.offset + 1] === '/') {
      advance(state);
      advance(state);
      return;
    }
    advance(state);
  }
  throw new SqlParseError(state.file, line, column, 'unterminated block comment');
}

function skipLineComment(state: TokenizerState): void {
  advance(state);
  advance(state);
  while (
    state.offset < state.sql.length &&
    state.sql[state.offset] !== '\r' &&
    state.sql[state.offset] !== '\n'
  ) {
    advance(state);
  }
}

function readQuotedToken(state: TokenizerState, char: string): boolean {
  if (char === "'") {
    readDelimited(state, "'", 'string', 'single-quoted string', true);
  } else if (char === '"') {
    readDelimited(state, '"', 'quotedIdentifier', 'double-quoted identifier', true);
  } else if (char === '`') {
    readDelimited(state, '`', 'quotedIdentifier', 'backtick-quoted identifier', true);
  } else if (char === '[') {
    readDelimited(state, ']', 'quotedIdentifier', 'bracket-quoted identifier', false);
  } else {
    return false;
  }
  return true;
}

function readWordOrSymbol(state: TokenizerState, char: string): void {
  const { line, column } = state;
  if (!isWordCharacter(char)) {
    state.tokens.push({ kind: 'symbol', value: advance(state), line, column });
    return;
  }
  let value = '';
  while (state.offset < state.sql.length && isWordCharacter(state.sql[state.offset] ?? '')) {
    value += advance(state);
  }
  state.tokens.push({ kind: 'word', value, line, column });
}

function readNextToken(state: TokenizerState): void {
  const char = state.sql[state.offset] ?? '';
  const next = state.sql[state.offset + 1] ?? '';
  if (/\s/.test(char)) {
    advance(state);
  } else if (char === '-' && next === '-') {
    skipLineComment(state);
  } else if (char === '/' && next === '*') {
    skipBlockComment(state);
  } else if (!readQuotedToken(state, char)) {
    readWordOrSymbol(state, char);
  }
}

/**
 * Tokenize the SQLite syntax used by D1 migrations while retaining source
 * positions. Comments are whitespace, string contents never become grammar
 * tokens, and quoted identifiers remain distinguishable from keywords.
 */
export function tokenizeSql(sql: string, file: string): SqlToken[] {
  const state: TokenizerState = { sql, file, tokens: [], offset: 0, line: 1, column: 1 };
  while (state.offset < sql.length) readNextToken(state);
  return state.tokens;
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

interface StatementSplitState {
  statements: SqlStatement[];
  current: SqlToken[];
  triggerBody: boolean;
  triggerClosed: boolean;
  caseDepth: number;
}

function finishStatement(state: StatementSplitState): void {
  if (state.current.length > 0) state.statements.push({ tokens: state.current });
  state.current = [];
  state.triggerBody = false;
  state.triggerClosed = false;
  state.caseDepth = 0;
}

function appendStatementToken(state: StatementSplitState, token: SqlToken): void {
  state.current.push(token);
  const previous = state.current[state.current.length - 2];
  const qualified = previous?.kind === 'symbol' && previous.value === '.';
  if (
    !state.triggerBody &&
    isCreateTrigger(state.current) &&
    !qualified &&
    isKeyword(token, 'begin')
  ) {
    state.triggerBody = true;
  } else if (state.triggerBody && !qualified && isKeyword(token, 'case')) {
    state.caseDepth += 1;
  } else if (state.triggerBody && !qualified && isKeyword(token, 'end')) {
    if (state.caseDepth > 0) state.caseDepth -= 1;
    else state.triggerClosed = true;
  }
}

function appendOrFinishStatement(state: StatementSplitState, token: SqlToken): void {
  if (token.kind !== 'symbol' || token.value !== ';') {
    appendStatementToken(state, token);
  } else if (state.triggerBody && !state.triggerClosed) {
    state.current.push(token);
  } else {
    finishStatement(state);
  }
}

function assertCompleteTrigger(state: StatementSplitState, file: string): void {
  if (!state.triggerBody || state.triggerClosed) return;
  const start = state.current[0];
  throw new SqlParseError(
    file,
    start?.line ?? 1,
    start?.column ?? 1,
    'unterminated CREATE TRIGGER body'
  );
}

/** Split top-level SQL while keeping CREATE TRIGGER BEGIN...END programs intact. */
export function splitSqlStatements(tokens: SqlToken[], file: string): SqlStatement[] {
  const state: StatementSplitState = {
    statements: [],
    current: [],
    triggerBody: false,
    triggerClosed: false,
    caseDepth: 0,
  };
  for (const token of tokens) appendOrFinishStatement(state, token);
  assertCompleteTrigger(state, file);
  finishStatement(state);
  return state.statements;
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
