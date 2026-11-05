import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import { Pane } from './Pane';
import { SearchField } from './SearchField';

const meta: Meta<typeof SearchField> = {
  title: 'SAM Glass/SearchField',
  component: SearchField,
};

export default meta;
type Story = StoryObj<typeof SearchField>;

function SearchStory() {
  const [value, setValue] = useState('');
  return (
    <Pane className="w-full max-w-80 space-y-2 p-3">
      <p className="m-0 text-sm text-fg-muted">Inputs are wells carved into the pane.</p>
      <SearchField value={value} onValueChange={setValue} placeholder="Search chats..." />
    </Pane>
  );
}

export const Well: Story = { render: () => <SearchStory /> };
