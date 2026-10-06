import { createFixtureServer } from '../../tests/fixtures/acp-c2-remote-service.mjs';

const fixture = createFixtureServer({
  publicUrl: 'https://fixture.example.test',
  mcpToken: 'probe-only',
  samPortProxy: true,
  formTool: true,
  log: (event) => process.stdout.write(JSON.stringify({ kind: event.kind }) + '\n'),
});
fixture.listener.listen(0, '127.0.0.1', () => {
  process.stdout.write(JSON.stringify({ port: fixture.listener.address().port }) + '\n');
});
process.on('SIGTERM', async () => {
  await fixture.close();
  fixture.listener.close(() => process.exit(0));
});
