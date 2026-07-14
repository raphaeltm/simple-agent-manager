import type { WebhookTriggerFilter } from '@simple-agent-manager/shared';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';

import { WebhookTriggerFields } from '../../../src/components/triggers/WebhookTriggerFields';

function Harness() {
  const [filters, setFilters] = useState<WebhookTriggerFilter[]>([]);
  return (
    <>
      <WebhookTriggerFields
        sourceLabel=""
        includedHeaders=""
        filterMode="all"
        filters={filters}
        onSourceLabelChange={() => undefined}
        onIncludedHeadersChange={() => undefined}
        onFilterModeChange={() => undefined}
        onFiltersChange={setFilters}
      />
      <output data-testid="filters">{JSON.stringify(filters)}</output>
    </>
  );
}

describe('WebhookTriggerFields', () => {
  it('preserves number, boolean, and null filter value types', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /add filter/i }));
    await user.selectOptions(screen.getByLabelText('Filter 1 operator'), 'equals');
    await user.selectOptions(screen.getByLabelText('Filter 1 value type'), 'number');
    const numberInput = screen.getByLabelText('Filter 1 value');
    await user.clear(numberInput);
    await user.type(numberInput, '42');
    expect(screen.getByTestId('filters')).toHaveTextContent('"value":42');

    await user.selectOptions(screen.getByLabelText('Filter 1 value type'), 'boolean');
    await user.selectOptions(screen.getByLabelText('Filter 1 value'), 'false');
    expect(screen.getByTestId('filters')).toHaveTextContent('"value":false');

    await user.selectOptions(screen.getByLabelText('Filter 1 value type'), 'null');
    expect(screen.getByTestId('filters')).toHaveTextContent('"value":null');
  });
});
