import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/handoff.js', import.meta.url), 'utf8');
function fixture() {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const elements = Object.fromEntries(
    [
      'claim-form',
      'recovery',
      'recovery-display',
      'recovery-saved',
      'claim-submit',
      'handoff-status',
    ].map((id) => [
      `maintenance-${id}`,
      {
        value: '',
        checked: false,
        disabled: false,
        readOnly: false,
        textContent: '',
        addEventListener: (name: string, callback: (event: { preventDefault(): void }) => void) =>
          listeners.set(name, callback),
      },
    ])
  );
  const fetch = vi.fn();
  runInNewContext(source, {
    document: { getElementById: (id: string) => elements[id] },
    crypto,
    Uint8Array,
    fetch,
  });
  return { elements, listeners, fetch };
}
describe('browser-generated maintenance recovery', () => {
  it('generates recovery before claim, requires acknowledgement, and sends no network requests', () => {
    const { elements, listeners, fetch } = fixture();
    const hidden = elements['maintenance-recovery']!,
      display = elements['maintenance-recovery-display']!,
      saved = elements['maintenance-recovery-saved']!,
      submit = elements['maintenance-claim-submit']!;
    expect(hidden.value).toMatch(/^[a-f0-9]{64}$/);
    expect(display.value).toBe(hidden.value);
    expect(display.readOnly).toBe(true);
    expect(submit.disabled).toBe(true);
    const preventDefault = vi.fn();
    listeners.get('submit')!({ preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    saved.checked = true;
    listeners.get('change')!({ preventDefault });
    expect(submit.disabled).toBe(false);
    preventDefault.mockClear();
    listeners.get('submit')!({ preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });
});
