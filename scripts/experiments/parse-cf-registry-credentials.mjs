import { readFileSync, appendFileSync } from 'node:fs';

const [filePath] = process.argv.slice(2);

if (!filePath) {
  console.error('Usage: parse-cf-registry-credentials.mjs <wrangler-output-file>');
  process.exit(2);
}

const raw = readFileSync(filePath, 'utf8');
const outputPath = process.env.GITHUB_OUTPUT;
const summaryPath = process.env.GITHUB_STEP_SUMMARY;

function redact(value) {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function parseJson(text) {
  const parsed = JSON.parse(text);
  return {
    registry: parsed.registry || parsed.registry_url || parsed.url || 'registry.cloudflare.com',
    username: parsed.username || parsed.user || parsed.login,
    password: parsed.password || parsed.token || parsed.secret,
  };
}

function parseText(text) {
  const get = (...labels) => {
    for (const label of labels) {
      const pattern = new RegExp(`^\\s*${label}\\s*[:=]\\s*(.+?)\\s*$`, 'im');
      const match = text.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
    return undefined;
  };

  return {
    registry: get('registry', 'server') || 'registry.cloudflare.com',
    username: get('username', 'user', 'login'),
    password: get('password', 'token', 'secret'),
  };
}

let credentials;
try {
  credentials = parseJson(raw);
} catch {
  credentials = parseText(raw);
}

if (!credentials.username || !credentials.password) {
  if (summaryPath) {
    appendFileSync(
      summaryPath,
      [
        '### Cloudflare registry credential parse failed',
        '',
        'Wrangler output, redacted:',
        '',
        '```text',
        raw.replace(/[A-Za-z0-9_-]{24,}/g, '***'),
        '```',
        '',
      ].join('\n')
    );
  }
  console.error('Could not parse username/password from Wrangler registry credential output.');
  process.exit(1);
}

if (outputPath) {
  appendFileSync(outputPath, `registry=${credentials.registry}\n`);
  appendFileSync(outputPath, `username=${credentials.username}\n`);
  appendFileSync(outputPath, `password=${credentials.password}\n`);
}

if (summaryPath) {
  appendFileSync(
    summaryPath,
    [
      '### Cloudflare registry credentials',
      '',
      `- Registry: \`${credentials.registry}\``,
      `- Username: \`${redact(credentials.username)}\``,
      `- Password/token: \`${redact(credentials.password)}\``,
      '',
    ].join('\n')
  );
}
