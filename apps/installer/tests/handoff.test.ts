import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../public/handoff.js', import.meta.url), 'utf8');
function fixture() {
  const listeners = new Map<string, (event: { preventDefault(): void }) => void>();
  const copyListeners = new Map<string, () => void>();
  const elements = Object.fromEntries(
    [
      'claim-form',
      'recovery',
      'recovery-display',
      'recovery-saved',
      'claim-submit',
      'handoff-status',
      'recovery-copy',
    ].map((id) => [
      `maintenance-${id}`,
      {
        value: '',
        checked: false,
        disabled: false,
        readOnly: false,
        textContent: '',
        select: vi.fn(),
        addEventListener: (name: string, callback: () => void) => {
          listeners.set(name, callback as (event: { preventDefault(): void }) => void);
          if (id === 'recovery-copy') copyListeners.set(name, callback);
        },
      },
    ])
  );
  const fetch = vi.fn();
  const writeText = vi.fn().mockResolvedValue(undefined);
  runInNewContext(source, {
    document: { getElementById: (id: string) => elements[id] },
    crypto,
    Uint8Array,
    fetch,
    navigator: { clipboard: { writeText } },
    setTimeout,
  });
  return { elements, listeners, copyListeners, fetch, writeText };
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
  it('copies the recovery credential to the clipboard and shows a temporary confirmation', async () => {
    vi.useFakeTimers();
    const { elements, copyListeners, writeText } = fixture();
    const display = elements['maintenance-recovery-display']!,
      copy = elements['maintenance-recovery-copy']!;
    const original = copy.textContent;
    await copyListeners.get('click')!();
    expect(writeText).toHaveBeenCalledWith(display.value);
    expect(copy.textContent).toBe('Copied');
    await vi.advanceTimersByTimeAsync(2000);
    expect(copy.textContent).toBe(original);
    vi.useRealTimers();
  });
  it('falls back to selecting the field when the clipboard API is unavailable', async () => {
    vi.useFakeTimers();
    const { elements, copyListeners, writeText } = fixture();
    writeText.mockRejectedValueOnce(new Error('denied'));
    const display = elements['maintenance-recovery-display']!;
    await copyListeners.get('click')!();
    expect(display.select).toHaveBeenCalledOnce();
    expect(elements['maintenance-recovery-copy']!.textContent).toContain('copy it manually');
    vi.useRealTimers();
  });
});
