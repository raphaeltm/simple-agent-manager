import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SELF_HOST_URL } from '../../../src/lib/public-website';
import { RetiredTrial } from '../../../src/pages/RetiredTrial';

describe('RetiredTrial', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('points stale trial links at the self-hosting guide and sign-in, without navigating itself', () => {
    const replace = vi.fn();
    const assign = vi.fn();
    vi.stubGlobal('location', { ...window.location, replace, assign });

    render(<RetiredTrial />);

    expect(screen.getByRole('heading', { name: 'Hosted trials have ended' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Self-host SAM' })).toHaveAttribute(
      'href',
      SELF_HOST_URL
    );
    expect(screen.getByRole('link', { name: 'Already have access? Sign in' })).toHaveAttribute(
      'href',
      '/'
    );
    expect(SELF_HOST_URL).toMatch(/^https:\/\/.+\/self-host\/$/);
    expect(replace).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
