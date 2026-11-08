import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SELF_HOST_URL } from '../../../src/lib/public-website';
import { RetiredTrial } from '../../../src/pages/RetiredTrial';

describe('RetiredTrial', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sends stale trial links to the self-hosting guide and keeps a manual link', () => {
    const replace = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace });

    render(<RetiredTrial />);

    expect(screen.getByRole('heading', { name: 'Hosted trials have ended' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Self-host SAM' })).toHaveAttribute(
      'href',
      SELF_HOST_URL
    );
    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith(SELF_HOST_URL);
    expect(SELF_HOST_URL).toMatch(/^https:\/\/.+\/self-host\/$/);
  });
});
