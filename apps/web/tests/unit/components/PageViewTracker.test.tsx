import { act,render } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { PageViewTracker } from '../../../src/components/PageViewTracker';

// Mock the analytics module so we can assert on track() calls
vi.mock('../../../src/lib/analytics', () => ({
  track: vi.fn(),
  getInitialReferrer: vi.fn().mockReturnValue('https://google.com'),
}));

import { getInitialReferrer,track } from '../../../src/lib/analytics';
const mockTrack = vi.mocked(track);
const mockGetInitialReferrer = vi.mocked(getInitialReferrer);

// Helper that allows navigating after mount
function NavigatorHarness({ to }: { to: string }) {
  const navigate = useNavigate();
  return (
    <button onClick={() => navigate(to)}>go</button>
  );
}

function renderTracker(initialPath = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PageViewTracker />
    </MemoryRouter>
  );
}

function renderTrackerWithNav(initialPath = '/dashboard', target = '/projects') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <PageViewTracker />
      <NavigatorHarness to={target} />
    </MemoryRouter>
  );
}

describe('PageViewTracker', () => {
  beforeEach(() => {
    vi.spyOn(performance, 'now').mockReturnValue(1000);
    mockTrack.mockClear();
    mockGetInitialReferrer.mockReturnValue('https://google.com');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('tracks page_view with initial referrer on first render', () => {
    renderTracker('/dashboard');

    expect(mockTrack).toHaveBeenCalledTimes(1);
    expect(mockTrack).toHaveBeenCalledWith('page_view', {
      page: '/dashboard',
      referrer: 'https://google.com',
    });
  });

  it('does not track page_duration on first render', () => {
    renderTracker('/dashboard');

    const durationCalls = mockTrack.mock.calls.filter(([name]) => name === 'page_duration');
    expect(durationCalls).toHaveLength(0);
  });

  it('tracks page_duration then page_view on route change', async () => {
    let now = 1000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const { getByText } = renderTrackerWithNav('/dashboard', '/projects');
    mockTrack.mockClear();

    now = 4500; // advance time before navigation
    await act(async () => {
      getByText('go').click();
    });

    expect(mockTrack).toHaveBeenCalledTimes(2);
    expect(mockTrack).toHaveBeenNthCalledWith(1, 'page_duration', {
      page: '/dashboard',
      durationMs: 3500,
    });
    expect(mockTrack).toHaveBeenNthCalledWith(2, 'page_view', {
      page: '/projects',
      referrer: '',
    });
  });

  it('uses empty referrer for subsequent navigations', async () => {
    const { getByText } = renderTrackerWithNav('/dashboard', '/projects');
    mockTrack.mockClear();

    await act(async () => {
      getByText('go').click();
    });

    const pageViewCall = mockTrack.mock.calls.find(([name]) => name === 'page_view');
    expect(pageViewCall?.[1]).toMatchObject({ referrer: '' });
  });

  it('renders nothing (returns null)', () => {
    const { container } = renderTracker('/dashboard');
    expect(container.firstChild).toBeNull();
  });

  it('computes correct durationMs from performance.now delta', async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);

    const { getByText } = renderTrackerWithNav('/page-a', '/page-b');
    mockTrack.mockClear();

    now = 2750;
    await act(async () => {
      getByText('go').click();
    });

    const durationCall = mockTrack.mock.calls.find(([name]) => name === 'page_duration');
    expect(durationCall?.[1]).toMatchObject({ durationMs: 2750 });
  });
});
