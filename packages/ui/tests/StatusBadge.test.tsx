import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { StatusBadge } from '../src/components/StatusBadge';

describe('StatusBadge', () => {
  describe('trigger statuses', () => {
    // Before these were registered, `<StatusBadge status="active"/>` rendered
    // the literal text "Unknown" — while STILL pulsing, because the pulse keys
    // off the raw status string rather than a resolved config entry.
    it.each([
      ['active', 'Active'],
      ['paused', 'Paused'],
      ['disabled', 'Disabled'],
    ])('renders %s as "%s"', (status, label) => {
      render(<StatusBadge status={status} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText('Unknown')).not.toBeInTheDocument();
    });
  });

  describe('pulse', () => {
    it('pulses a live status by default', () => {
      const { container } = render(<StatusBadge status="running" />);
      expect(container.firstElementChild?.className).toContain('sam-status-pulse');
    });

    it('suppresses the pulse when explicitly disabled', () => {
      // Trigger lists opt out: an armed trigger is steady-state configuration,
      // not live activity, and a page of glowing badges reads as noise.
      const { container } = render(<StatusBadge status="active" pulse={false} />);
      expect(container.firstElementChild?.className).not.toContain('sam-status-pulse');
      expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('can force a pulse onto a normally-static status', () => {
      const { container } = render(<StatusBadge status="paused" pulse />);
      expect(container.firstElementChild?.className).toContain('sam-status-pulse');
    });

    it('leaves a static status unpulsed by default', () => {
      const { container } = render(<StatusBadge status="stopped" />);
      expect(container.firstElementChild?.className).not.toContain('sam-status-pulse');
    });
  });

  it('falls back to "Unknown" for an unregistered status', () => {
    render(<StatusBadge status="not-a-real-status" />);
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('prefers an explicit label over the registered one', () => {
    render(<StatusBadge status="active" label="Armed" />);
    expect(screen.getByText('Armed')).toBeInTheDocument();
    expect(screen.queryByText('Active')).not.toBeInTheDocument();
  });
});
