// Runs an installer command and reports a failure as its message, not a stack trace.
// Messages never carry tokens or Cloudflare response bodies (installer-target.mjs).
const commands = ['deploy', 'remove', 'check-live'];
const command = process.argv[2];
if (!commands.includes(command)) {
  console.error(`Usage: node scripts/cli.mjs <${commands.join('|')}>`);
  process.exit(2);
}
try {
  await import(`./${command}.mjs`);
} catch (error) {
  console.error(`\n${error instanceof Error ? error.message : 'The command failed.'}`);
  process.exit(1);
}
