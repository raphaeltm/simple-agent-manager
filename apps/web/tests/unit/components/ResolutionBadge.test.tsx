import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ResolutionBadge } from '../../../src/components/ResolutionBadge';

describe('ResolutionBadge', () => {
  const cases: Array<{ source: string; label: string }> = [
    { source: 'project-attachment', label: 'This project' },
    { source: 'user-attachment', label: 'Your default' },
    { source: 'platform', label: 'SAM platform' },
    { source: 'platform-proxy', label: 'SAM proxy' },
    { source: 'halted', label: 'Halted' },
    { source: 'unresolved', label: 'Not configured' },
  ];

  for (const { source, label } of cases) {
    it(`renders "${label}" for source "${source}"`, () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      render(<ResolutionBadge source={source as any} />);
      expect(screen.getByText(label)).toBeInTheDocument();
    });
  }

  it('falls back to "Not configured" for unknown source', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    render(<ResolutionBadge source={'unknown-value' as any} />);
    expect(screen.getByText('Not configured')).toBeInTheDocument();
  });
});
