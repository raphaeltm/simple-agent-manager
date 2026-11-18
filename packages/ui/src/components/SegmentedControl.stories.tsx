import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { Pane } from './Pane';
import { SegmentedControl } from './SegmentedControl';

const meta: Meta<typeof SegmentedControl> = {
  title: 'SAM Glass/SegmentedControl',
  component: SegmentedControl,
};

export default meta;
type Story = StoryObj<typeof SegmentedControl>;

function OwnershipFilter() {
  const [value, setValue] = useState<'my' | 'all'>('all');
  return (
    <Pane className="w-full max-w-72 p-3">
      <SegmentedControl
        label="Session ownership filter"
        value={value}
        onChange={setValue}
        options={[
          { value: 'my', label: 'Mine', count: 3 },
          { value: 'all', label: 'All', count: 10 },
        ]}
      />
    </Pane>
  );
}

export const WithCounts: Story = { render: () => <OwnershipFilter /> };
