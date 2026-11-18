import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';

import { AccountsBody } from '../../../../src/pages/insights/AccountsTab';
import { makeAccounts } from '../../../playwright/insights-accounts-fixtures';

describe('Accounts admission disclosure', () => {
  it('shows known incomplete usage even when no usage or account cards exist', () => {
    const data = makeAccounts('p', '30d', 'empty');
    render(
      <MemoryRouter>
        <AccountsBody data={{ ...data, usageAdmissionLimited: true }} />
      </MemoryRouter>
    );
    expect(screen.getByText('Token usage is incomplete for this range.')).toBeInTheDocument();
    expect(screen.getByText('No runs in this range')).toBeInTheDocument();
  });

  it('does not relabel complete account totals when admission loss belongs to another run', () => {
    const data = { ...makeAccounts('p', '30d', 'realistic'), usageAdmissionLimited: true };
    render(
      <MemoryRouter>
        <AccountsBody data={data} />
      </MemoryRouter>
    );
    expect(screen.getByText(/Token usage is incomplete/)).toBeInTheDocument();
    const account = screen.getByTestId('insights-account-cred:cc-key');
    expect(account).toHaveTextContent('21.6M');
    expect(account).not.toHaveTextContent('21.6M+');
    expect(account).toHaveTextContent('41.27');
    expect(account).not.toHaveTextContent('At least');
  });

  it('keeps the ordinary empty state free of an incomplete warning', () => {
    render(
      <MemoryRouter>
        <AccountsBody data={makeAccounts('p', '30d', 'empty')} />
      </MemoryRouter>
    );
    expect(screen.queryByText(/Token usage is incomplete/)).not.toBeInTheDocument();
    expect(screen.getByText('No runs in this range')).toBeInTheDocument();
  });
});
