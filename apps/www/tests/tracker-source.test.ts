/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from 'vitest';

async function readBeaconEvents(sendBeacon: ReturnType<typeof vi.fn>) {
  const blob = sendBeacon.mock.calls.at(-1)?.[1] as Blob;
  return JSON.parse(await blob.text()).events as Array<Record<string, unknown>>;
}

async function installTracker(url: string, referrer = '') {
  window.history.pushState({}, '', url);
  Object.defineProperty(document, 'referrer', { value: referrer, configurable: true });

  const script = document.createElement('script');
  script.setAttribute('data-api', 'https://api.example.com/api/t');
  Object.defineProperty(document, 'currentScript', { value: script, configurable: true });

  const sendBeacon = vi.fn().mockReturnValue(true);
  Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');

  vi.resetModules();
  // @ts-expect-error tracker.ts is intentionally compiled as a classic script, not an ES module.
  await import('../src/scripts/tracker');
  return { sendBeacon };
}

describe('public website tracker source coverage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    vi.restoreAllMocks();
  });

  it('covers redaction and navigation behavior before browser-asset compilation', async () => {
    const { sendBeacon } = await installTracker(
      '/projects/01KZ941C7W5JRFDA9RDZASV8EE/repos/raphaeltm/simple-agent-manager/blob/apps/www/src/scripts/tracker.ts?utm_source=newsletter&utm_medium=email&utm_campaign=launch&token=secret#frag',
      'https://user:pass@example.com/oauth/callback/user@example.com?code=secret#frag'
    );

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    let [event] = await readBeaconEvents(sendBeacon);
    expect(event).toMatchObject({
      event: 'page_view',
      page: '/projects/[redacted]/repos/[redacted]/simple-agent-manager/blob/apps/www/src/scripts/[redacted]',
      referrer: 'https://example.com/oauth/[redacted]/[redacted]',
      host: 'localhost',
      utmSource: 'newsletter',
      utmMedium: 'email',
      utmCampaign: 'launch',
    });
    expect(JSON.stringify(event)).not.toContain('01KZ941C7W5JRFDA9RDZASV8EE');
    expect(JSON.stringify(event)).not.toContain('token=secret');
    expect(JSON.stringify(event)).not.toContain('#frag');
    expect(JSON.stringify(event)).not.toContain('user@example.com');

    document.dispatchEvent(new Event('astro:page-load'));
    expect(sendBeacon).toHaveBeenCalledTimes(1);

    window.history.pushState({}, '', '/invite/user@example.com/accept?code=secret#frag');
    document.dispatchEvent(new Event('astro:page-load'));

    expect(sendBeacon).toHaveBeenCalledTimes(2);
    [event] = await readBeaconEvents(sendBeacon);
    expect(event.page).toBe('/invite/[redacted]/accept');
    expect(JSON.stringify(event)).not.toContain('user@example.com');
    expect(JSON.stringify(event)).not.toContain('code=secret');
  });
});
