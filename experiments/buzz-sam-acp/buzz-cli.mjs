import { spawn } from 'node:child_process';

import { safeDiagnostic } from './configuration.mjs';

const PASSTHROUGH_ENV = new Set([
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'USERPROFILE',
  'WINDIR',
  'XDG_CONFIG_HOME',
]);

export function parseBuzzTarget(text) {
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const channelIds = new Set();
  for (const pattern of [
    new RegExp(`^\\s*Channel:\\s+.*\\(#(${uuid})\\)\\s*$`, 'gim'),
    new RegExp(`^\\s*Channel:\\s+#?(${uuid})\\s*$`, 'gim'),
  ]) {
    for (const match of text.matchAll(pattern)) channelIds.add(match[1].toLowerCase());
  }
  if (channelIds.size === 0) {
    throw new Error('Buzz prompt did not contain a recognizable channel UUID');
  }
  if (channelIds.size > 1) {
    throw new Error('Buzz prompt contained conflicting channel UUIDs');
  }

  const replyIds = new Set(
    [...text.matchAll(/--reply-to\s+([0-9a-f]{64})\b/gi)].map((match) => match[1].toLowerCase())
  );
  if (replyIds.size > 1) throw new Error('Buzz prompt contained conflicting reply targets');

  return {
    channelId: [...channelIds][0],
    replyTo: replyIds.size === 1 ? [...replyIds][0] : null,
  };
}

function buzzEnvironment(source) {
  return Object.fromEntries(
    Object.entries(source).filter(
      ([name, value]) =>
        typeof value === 'string' && (name.startsWith('BUZZ_') || PASSTHROUGH_ENV.has(name))
    )
  );
}

export async function postToBuzz(config, target, content, sourceEnv = process.env) {
  // PROTOTYPE SHORTCUT: the reply-only posture keeps the Buzz identity on this
  // machine. A product version needs an explicit capability/trust design before
  // it can delegate Buzz tools or identity to a remote workspace.
  const args = ['messages', 'send', '--channel', target.channelId, '--content', '-'];
  if (target.replyTo) args.push('--reply-to', target.replyTo);

  await new Promise((resolve, reject) => {
    const child = spawn(config.buzzCli, args, {
      env: buzzEnvironment(sourceEnv),
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, config.buzzTimeoutMs);
    timeout.unref();

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr = `${stderr}${chunk}`.slice(-config.buzzStderrLimit);
    });
    child.on('error', (error) => {
      settle(
        new Error(
          `failed to start Buzz CLI: ${safeDiagnostic(error.message, config.buzzStderrLimit)}`
        )
      );
    });
    child.on('close', (code) => {
      if (timedOut) {
        settle(new Error(`Buzz CLI timed out after ${config.buzzTimeoutMs}ms`));
      } else if (code === 0) {
        settle();
      } else {
        settle(
          new Error(
            `Buzz CLI exited ${code}: ${safeDiagnostic(stderr.trim(), config.buzzStderrLimit) || 'no error detail'}`
          )
        );
      }
    });
    child.stdin.on('error', (error) => {
      if (timedOut) return;
      child.kill('SIGKILL');
      settle(
        new Error(
          `failed to write to Buzz CLI: ${safeDiagnostic(error.message, config.buzzStderrLimit)}`
        )
      );
    });
    child.stdin.end(content);
  });
}
