/**
 * Logging and output formatting utilities for deployment scripts.
 * Provides consistent, colorful CLI output.
 */

// ANSI color codes
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',
} as const;

// Check if colors are supported
const supportsColor =
  process.env.FORCE_COLOR !== '0' &&
  (process.env.FORCE_COLOR === '1' ||
    process.stdout.isTTY ||
    process.env.TERM !== 'dumb');

function colorize(color: keyof typeof colors, text: string): string {
  if (!supportsColor) return text;
  return `${colors[color]}${text}${colors.reset}`;
}

// ============================================================================
// Symbols
// ============================================================================

export const symbols = {
  success: supportsColor ? '✓' : '[OK]',
  error: supportsColor ? '✗' : '[ERROR]',
  warning: supportsColor ? '⚠' : '[WARN]',
  info: supportsColor ? 'ℹ' : '[INFO]',
  arrow: supportsColor ? '→' : '->',
  bullet: supportsColor ? '•' : '*',
  spinner: supportsColor ? '◌' : 'o',
};

// ============================================================================
// Core Logging Functions
// ============================================================================

let verboseMode = false;

export function setVerbose(verbose: boolean): void {
  verboseMode = verbose;
}

export function isVerbose(): boolean {
  return verboseMode;
}

export function log(message: string): void {
  console.log(message);
}

export function info(message: string): void {
  console.log(`${colorize('blue', symbols.info)} ${message}`);
}

export function success(message: string): void {
  console.log(`${colorize('green', symbols.success)} ${message}`);
}

export function warning(message: string): void {
  console.log(`${colorize('yellow', symbols.warning)} ${message}`);
}

export function error(message: string): void {
  console.error(`${colorize('red', symbols.error)} ${message}`);
}

export function verbose(message: string): void {
  if (verboseMode) {
    console.log(`${colorize('gray', `  ${message}`)}`);
  }
}

export function debug(message: string): void {
  if (verboseMode) {
    console.log(colorize('dim', `[DEBUG] ${message}`));
  }
}

// ============================================================================
// Formatting Helpers
// ============================================================================

export function bold(text: string): string {
  return colorize('bold', text);
}

export function dim(text: string): string {
  return colorize('dim', text);
}

export function cyan(text: string): string {
  return colorize('cyan', text);
}

export function green(text: string): string {
  return colorize('green', text);
}

export function yellow(text: string): string {
  return colorize('yellow', text);
}

export function red(text: string): string {
  return colorize('red', text);
}

// ============================================================================
// Output Sections
// ============================================================================

export function header(title: string): void {
  const line = '─'.repeat(60);
  log('');
  log(colorize('cyan', line));
  log(colorize('bold', `  ${title}`));
  log(colorize('cyan', line));
  log('');
}

export function section(title: string): void {
  log('');
  log(colorize('bold', `${symbols.arrow} ${title}`));
}

export function divider(): void {
  log(colorize('dim', '─'.repeat(40)));
}

export function newline(): void {
  log('');
}

// ============================================================================
// Data Display
// ============================================================================

export function keyValue(key: string, value: string): void {
  log(`  ${colorize('dim', key + ':')} ${value}`);
}

export function list(items: string[], prefix: string = symbols.bullet): void {
  items.forEach((item) => {
    log(`  ${prefix} ${item}`);
  });
}

export function table(
  data: Array<Record<string, string>>,
  columns: string[]
): void {
  if (data.length === 0) return;

  // Calculate column widths
  const widths: Record<string, number> = {};
  columns.forEach((col) => {
    widths[col] = Math.max(
      col.length,
      ...data.map((row) => (row[col] || '').length)
    );
  });

  // Print header
  const headerLine = columns
    .map((col) => col.padEnd(widths[col]))
    .join('  ');
  log(colorize('bold', headerLine));
  log(colorize('dim', '─'.repeat(headerLine.length)));

  // Print rows
  data.forEach((row) => {
    const rowLine = columns
      .map((col) => (row[col] || '').padEnd(widths[col]))
      .join('  ');
    log(rowLine);
  });
}

// ============================================================================
// Status Messages
// ============================================================================

export function step(number: number, total: number, message: string): void {
  const prefix = colorize('dim', `[${number}/${total}]`);
  log(`${prefix} ${message}`);
}

export function stepSuccess(
  number: number,
  total: number,
  message: string
): void {
  const prefix = colorize('dim', `[${number}/${total}]`);
  log(`${prefix} ${colorize('green', symbols.success)} ${message}`);
}

export function stepError(
  number: number,
  total: number,
  message: string,
  details?: string
): void {
  const prefix = colorize('dim', `[${number}/${total}]`);
  log(`${prefix} ${colorize('red', symbols.error)} ${message}`);
  if (details) {
    log(colorize('red', `    ${details}`));
  }
}

// ============================================================================
// URL and Path Display
// ============================================================================

export function url(label: string, urlValue: string): void {
  log(`  ${label}: ${colorize('cyan', urlValue)}`);
}

export function filepath(label: string, path: string): void {
  log(`  ${label}: ${colorize('yellow', path)}`);
}

// ============================================================================
// Deployment Output
// ============================================================================

export function deploymentSummary(urls: {
  api?: string;
  web?: string;
}): void {
  header('Deployment Complete!');

  if (urls.api || urls.web) {
    section('Application URLs');
    if (urls.api) url('API', urls.api);
    if (urls.web) url('Web', urls.web);
  }

  newline();
  info('Your deployment is ready.');
  newline();
}

export function errorSummary(
  errorMessage: string,
  details?: string[],
  remediation?: string
): void {
  header('Deployment Failed');

  error(errorMessage);

  if (details && details.length > 0) {
    newline();
    section('Error Details');
    list(details);
  }

  if (remediation) {
    newline();
    section('How to Fix');
    log(`  ${remediation}`);
  }

  newline();
}
