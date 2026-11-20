/**
 * Runs one legacy adoption in its own process so legacy-adoption.live.test.ts can SIGKILL it in
 * the middle of a volume copy. argv[2] is the fixture JSON (legacy-adoption-fixture.ts).
 */
import { runLegacyAdoption } from '../legacy-adoption.js';
import {
  ALPINE,
  fakeBackup,
  FakeGit,
  type Fixture,
  fixtureContext,
  FROM,
  projectHealth,
  TO,
} from './legacy-adoption-fixture.js';

const parsed: unknown = JSON.parse(process.argv[2] ?? '{}');
const keys = [
  'root',
  'selfhostDir',
  'envFile',
  'stateDir',
  'composeFile',
  'legacyProject',
  'envText',
];
if (
  !parsed ||
  typeof parsed !== 'object' ||
  !keys.every((key) => typeof (parsed as Record<string, unknown>)[key] === 'string')
)
  throw new Error('legacy-adoption-child: invalid fixture argument');
const fixture = parsed as Fixture;
const git = new FakeGit(TO);
const ctx = fixtureContext(fixture, git, []);
await runLegacyAdoption(ctx, {
  to: TO,
  from: FROM,
  checkHealth: projectHealth(fixture),
  backup: fakeBackup([]),
  upgrade: async () => {},
  legacyProject: fixture.legacyProject,
  helperImage: ALPINE,
  checkoutRoot: fixture.root,
});
