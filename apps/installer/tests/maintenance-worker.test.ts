import { expect, it, vi } from 'vitest';

import { maintenanceSource } from '../src/maintenance';

it('routes the uploaded Worker through one durable owner coordinator', async () => {
  const worker = new Function(
    maintenanceSource
      .replace('export class MaintenanceCoordinator', 'class MaintenanceCoordinator')
      .replace('export default', 'return')
  )() as { fetch(request: Request, env: unknown): Promise<Response> };
  const request = new Request('https://maintenance.example.com/health');
  const response = new Response('durable coordinator');
  const fetch = vi.fn(async () => response);
  const idFromName = vi.fn(() => 'installation-owner');
  const get = vi.fn(() => ({ fetch }));
  expect(await worker.fetch(request, { MAINTENANCE: { idFromName, get } })).toBe(response);
  expect(idFromName).toHaveBeenCalledWith('owner');
  expect(get).toHaveBeenCalledWith('installation-owner');
  expect(fetch).toHaveBeenCalledWith(request);
});
