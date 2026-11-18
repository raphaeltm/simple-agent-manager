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
        <AccountsBody data={{ ...data, usageLimited: true }} />
      </MemoryRouter>
    );
    expect(
      screen.getByText(
        'Token usage is incomplete for this range. Some usage could not be recorded; shown token and spend totals are lower bounds.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText('No runs in this range')).toBeInTheDocument();
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
