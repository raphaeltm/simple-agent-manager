import { describe, expect, it } from 'vitest';

import { maintenanceSource } from '../src/maintenance';
import { digest } from '../src/security';

// Execute exactly the dependency-free module that gets uploaded, not a separate mock.
const maintenance = new Function(maintenanceSource.replace('export default', 'return'))() as {
  fetch(request: Request, env: Record<string, string>): Promise<Response>;
};
describe('uploaded maintenance module', () => {
  it('protects administration, claims only from installer, supports cross-site landing and expires access', async () => {
    const origin = 'https://install.example.com',
      target = 'https://sam-maintenance.example.workers.dev';
    const env = {
      INSTALLER_ORIGIN: origin,
      OWNER_KEY_HASH: await digest('owner-secret'),
      CLAIM_EXPIRES: String(Date.now() + 60000),
    };
    expect((await maintenance.fetch(new Request(target), env)).status).toBe(401);
    const form = () => new URLSearchParams({ key: 'owner-secret' });
    expect(
      (
        await maintenance.fetch(
          new Request(`${target}/claim`, {
            method: 'POST',
            headers: { Origin: 'https://attacker.example' },
            body: form(),
          }),
          env
        )
      ).status
    ).toBe(403);
    const claim = await maintenance.fetch(
      new Request(`${target}/claim`, { method: 'POST', headers: { Origin: origin }, body: form() }),
      env
    );
    expect(claim.status).toBe(303);
    expect(claim.headers.get('Set-Cookie')).toContain('SameSite=Lax');
    const request = new Request(target, {
      headers: { Cookie: '__Host-sam-maintenance=owner-secret' },
    });
    expect(await (await maintenance.fetch(request, env)).text()).toContain(
      'Ownership handoff verified'
    );
    env.CLAIM_EXPIRES = String(Date.now() - 1);
    expect((await maintenance.fetch(request, env)).status).toBe(401);
  });
});
