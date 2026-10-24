/**
 * The shared row and pull-request badge, exercised through their own props.
 *
 * `LinkedWorkRow`'s `timestamp` and `secondaryMeta`, and `PullRequestStateBadge`'s `showChecks`,
 * exist because the idea page asked for them (coordinator decision on `feature.linked-work`) and
 * have no caller in this task. Untested props are props nobody can rely on, so they are covered
 * here rather than handed over unproven.
 */
import { render, screen, within } from '@testing-library/react';
import { FileText } from 'lucide-react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { LinkedWorkRow, PullRequestStateBadge } from '../../../../src/components/linked-work';

function renderRow(props: Partial<Parameters<typeof LinkedWorkRow>[0]> = {}) {
  return render(
    <MemoryRouter>
      <LinkedWorkRow
        icon={FileText}
        accent="var(--sam-color-info-fg)"
        title="report.md"
        to="/projects/p/library"
        testId="row"
        {...props}
      />
    </MemoryRouter>
  );
}

describe('LinkedWorkRow', () => {
  it('renders the title, the relation line and a chevron, and links in-app', () => {
    renderRow({ meta: 'Uploaded · /engineering' });
    const row = screen.getByTestId('row');
    expect(row).toHaveTextContent('report.md');
    expect(row).toHaveTextContent('Uploaded · /engineering');
    expect(row).toHaveAttribute('href', '/projects/p/library');
    expect(row.tagName).toBe('A');
  });

  it('renders no meta line at all when there is nothing to say', () => {
    // A stray separator or an empty row is worse than no line.
    renderRow({ meta: '' });
    const row = screen.getByTestId('row');
    expect(row).toHaveTextContent('report.md');
    expect(within(row).queryByText('·')).toBeNull();
  });

  it('renders a trailing slot inline with the relation line', () => {
    renderRow({ meta: '#7', trailing: <span data-testid="pill">Open</span> });
    expect(within(screen.getByTestId('row')).getByTestId('pill')).toBeInTheDocument();
  });

  it('renders a second subtitle line when given one', () => {
    renderRow({ meta: 'Opened', secondaryMeta: '+412 −88, 7 files' });
    const row = screen.getByTestId('row');
    expect(row).toHaveTextContent('Opened');
    expect(row).toHaveTextContent('+412 −88, 7 files');
  });

  it('renders a right-aligned timestamp without pushing the title out', () => {
    renderRow({ meta: 'Opened', timestamp: '2h ago' });
    expect(screen.getByTestId('row')).toHaveTextContent('2h ago');
  });

  it('omits both optional lines when they are not given', () => {
    // Paired with the positive assertions above: these must not render an empty element.
    renderRow({ meta: 'Opened' });
    const row = screen.getByTestId('row');
    expect(row).toHaveTextContent('Opened');
    expect(row).not.toHaveTextContent('2h ago');
    expect(row.textContent).toBe('report.mdOpened');
  });

  it('opens an external destination in a new tab, safely', () => {
    renderRow({ to: undefined, href: 'https://github.com/owner/repo/pull/1' });
    const row = screen.getByTestId('row');
    expect(row).toHaveAttribute('href', 'https://github.com/owner/repo/pull/1');
    expect(row).toHaveAttribute('target', '_blank');
    expect(row).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

const state = (overrides: Partial<Parameters<typeof PullRequestStateBadge>[0]['state']> = {}) => ({
  state: 'open' as const,
  isDraft: false,
  title: null,
  checksState: 'failure' as const,
  mergedAt: null,
  updatedAt: null,
  stale: false,
  ...overrides,
});

describe('PullRequestStateBadge', () => {
  it('renders the checks word by default', () => {
    render(<PullRequestStateBadge state={state()} />);
    expect(screen.getByTestId('pr-state-badge')).toHaveTextContent('Open');
    expect(screen.getByTestId('pr-checks-state')).toHaveTextContent('Checks failing');
  });

  it('drops the checks word when the caller has no room for it', () => {
    // Positive control beside the absence: the state pill is still there.
    render(<PullRequestStateBadge state={state()} showChecks={false} />);
    expect(screen.getByTestId('pr-state-badge')).toHaveTextContent('Open');
    expect(screen.queryByTestId('pr-checks-state')).toBeNull();
  });

  it('says nothing about inconclusive checks', () => {
    render(<PullRequestStateBadge state={state({ checksState: 'neutral' })} />);
    expect(screen.getByTestId('pr-state-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('pr-checks-state')).toBeNull();
  });

  it('calls an open draft a draft, because that is what decides whether to look', () => {
    render(<PullRequestStateBadge state={state({ isDraft: true, checksState: null })} />);
    const badge = screen.getByTestId('pr-state-badge');
    expect(badge).toHaveTextContent('Draft');
    expect(badge).toHaveAttribute('data-state', 'draft');
  });

  it('does not call a merged pull request a draft', () => {
    // `isDraft` is stale on a merged PR; the state is the fact that matters.
    render(<PullRequestStateBadge state={state({ state: 'merged', isDraft: true })} />);
    const badge = screen.getByTestId('pr-state-badge');
    expect(badge).toHaveTextContent('Merged');
    expect(badge).toHaveAttribute('data-state', 'merged');
  });

  it('renders nothing at all when the state is unknown', () => {
    const { container } = render(<PullRequestStateBadge state={null} />);
    expect(container).toBeEmptyDOMElement();
  });
});
