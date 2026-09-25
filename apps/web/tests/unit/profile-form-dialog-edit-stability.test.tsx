import type { AgentProfile } from '@simple-agent-manager/shared';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProfileFormDialog } from '../../src/components/agent-profiles/ProfileFormDialog';

vi.mock('../../src/components/agent-profiles/ProfileRuntimeSection', () => ({
  ProfileRuntimeSection: () => <div data-testid="runtime-section" />,
}));
vi.mock('../../src/components/ModelSelect', () => ({
  ModelSelect: ({ value }: { value: string }) => <div data-testid="model-select">{value}</div>,
}));

/**
 * The profile edit form loads its row when it opens and must then leave the
 * user's in-progress edits alone.
 *
 * `agentProfiles` is a TanStack cache entry shared by five surfaces, so the same
 * row arrives as a NEW object whenever it is refetched or written back by a
 * mutation from another surface. The populate effect used to be keyed on the
 * `profile` object, so one of those background refreshes silently re-ran every
 * `setX(profile.…)` and reverted whatever had been typed.
 */
function makeProfile(overrides: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'prof_1',
    projectId: 'proj_1',
    name: 'Fast Implementer',
    description: 'Original description',
    agentType: 'claude-code',
    effort: 'auto',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as AgentProfile;
}

const NAME_FIELD = 'e.g. Fast Implementer';

describe('ProfileFormDialog edit stability', () => {
  it('keeps in-progress edits when the same row arrives with a new object identity', () => {
    const profile = makeProfile();
    const { rerender } = render(
      <ProfileFormDialog
        isOpen
        onClose={vi.fn()}
        profile={profile}
        onSave={vi.fn()}
        projectId="proj_1"
      />
    );

    const name = screen.getByPlaceholderText(NAME_FIELD) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'My Renamed Profile' } });
    expect(name.value).toBe('My Renamed Profile');

    // A background refetch / cross-surface mutation writes the same row back with
    // a fresh object identity and a moved `updatedAt`.
    rerender(
      <ProfileFormDialog
        isOpen
        onClose={vi.fn()}
        profile={makeProfile({ updatedAt: '2026-09-24T12:00:00.000Z' })}
        onSave={vi.fn()}
        projectId="proj_1"
      />
    );

    // Liveness: the form is still mounted and rendering this profile's other fields.
    expect(screen.getByPlaceholderText('What this profile is for...')).toBeInTheDocument();
    expect(name).toBeInTheDocument();

    expect(name.value).toBe('My Renamed Profile');
  });

  it('CONTROL: still repopulates when the dialog is pointed at a different profile', () => {
    const { rerender } = render(
      <ProfileFormDialog
        isOpen
        onClose={vi.fn()}
        profile={makeProfile()}
        onSave={vi.fn()}
        projectId="proj_1"
      />
    );

    const name = screen.getByPlaceholderText(NAME_FIELD) as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Half-typed edit' } });

    rerender(
      <ProfileFormDialog
        isOpen
        onClose={vi.fn()}
        profile={makeProfile({ id: 'prof_2', name: 'Careful Reviewer' })}
        onSave={vi.fn()}
        projectId="proj_1"
      />
    );

    expect((screen.getByPlaceholderText(NAME_FIELD) as HTMLInputElement).value).toBe(
      'Careful Reviewer'
    );
  });

  it('CONTROL: populates from the freshest row when the dialog opens', () => {
    const { rerender } = render(
      <ProfileFormDialog
        isOpen={false}
        onClose={vi.fn()}
        profile={makeProfile()}
        onSave={vi.fn()}
        projectId="proj_1"
      />
    );

    rerender(
      <ProfileFormDialog
        isOpen
        onClose={vi.fn()}
        profile={makeProfile({ name: 'Renamed Elsewhere' })}
        onSave={vi.fn()}
        projectId="proj_1"
      />
    );

    expect((screen.getByPlaceholderText(NAME_FIELD) as HTMLInputElement).value).toBe(
      'Renamed Elsewhere'
    );
  });
});
