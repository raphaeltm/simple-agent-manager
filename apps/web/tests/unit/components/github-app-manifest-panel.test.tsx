import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, useLocation } from 'react-router';
import { beforeEach, expect, it, vi } from 'vitest';

import { GitHubAppManifestPanel } from '../../../src/components/GitHubAppManifestPanel';

const api = vi.hoisted(() => ({ start: vi.fn(), complete: vi.fn() }));
vi.mock('../../../src/lib/api', () => ({
  startGitHubAppManifest: api.start,
  completeGitHubAppManifest: api.complete,
}));

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}

function renderAt(url: string, onStored = vi.fn(), appConfigured = false) {
  render(
    <StrictMode>
      <MemoryRouter initialEntries={[url]}>
        <GitHubAppManifestPanel appConfigured={appConfigured} onStored={onStored} />
        <Location />
      </MemoryRouter>
    </StrictMode>
  );
  return onStored;
}

beforeEach(() => {
  api.start.mockReset();
  api.complete.mockReset();
});

it('finishes once when GitHub returns with code and state, and clears them from the URL', async () => {
  api.complete.mockResolvedValue({
    app: {
      slug: 'sam-box',
      htmlUrl: null,
      owner: 'octo',
      installUrl: 'https://github.com/apps/sam-box/installations/new',
    },
    status: { setupCompleted: true },
  });
  const onStored = renderAt('/admin/integrations?code=abc123&state=' + 'f'.repeat(64));
  expect(await screen.findByText(/created and saved/)).toBeInTheDocument();
  expect(api.complete).toHaveBeenCalledTimes(1);
  expect(api.complete).toHaveBeenCalledWith('abc123', 'f'.repeat(64));
  expect(onStored).toHaveBeenCalledWith({ status: { setupCompleted: true } });
  expect(screen.getByTestId('location')).toHaveTextContent(/^\/admin\/integrations$/);
  expect(screen.getByRole('link', { name: /Install it/ })).toHaveAttribute(
    'href',
    'https://github.com/apps/sam-box/installations/new'
  );
});

it('shows the API error when GitHub refused the code', async () => {
  api.complete.mockRejectedValue(new Error('GitHub did not accept the App creation code'));
  renderAt('/admin/integrations?code=old&state=' + 'a'.repeat(64));
  expect(await screen.findByText(/did not accept/)).toBeInTheDocument();
});

it('posts the manifest to GitHub as a form, and warns before replacing a configured App', async () => {
  const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => {});
  api.start.mockResolvedValue({
    postUrl: 'https://github.com/settings/apps/new?state=s',
    manifest: { name: 'SAM box' },
    state: 's',
  });
  renderAt('/admin/integrations', vi.fn(), true);
  expect(screen.getByText(/already configured/)).toBeInTheDocument();
  expect(api.complete).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText('my-org'), { target: { value: 'acme' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create GitHub App on GitHub' }));
  await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  expect(api.start).toHaveBeenCalledWith({ name: undefined, organization: 'acme' });
  const form = document.querySelector(
    'form[action="https://github.com/settings/apps/new?state=s"]'
  );
  expect(form?.getAttribute('method')?.toUpperCase()).toBe('POST');
  expect((form?.querySelector('input[name="manifest"]') as HTMLInputElement).value).toBe(
    JSON.stringify({ name: 'SAM box' })
  );
  submit.mockRestore();
});
