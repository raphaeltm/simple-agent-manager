import type { Meta, StoryObj } from '@storybook/react';
import { Bell, MessageSquare, MessageSquareQuote } from 'lucide-react';
import { MemoryRouter } from 'react-router';

import { NavItem, NavLabel } from './NavItem';
import { Pane } from './Pane';

const meta: Meta<typeof NavItem> = {
  title: 'SAM Glass/NavItem',
  component: NavItem,
};

export default meta;
type Story = StoryObj<typeof NavItem>;

export const Sidebar: Story = {
  render: () => (
    <MemoryRouter>
      <Pane as="nav" aria-label="Project navigation" className="flex w-60 flex-col gap-0.5 p-3">
        <NavLabel>SAM</NavLabel>
        <NavItem to="/chat" label="Chat" icon={<MessageSquare size={18} />} current />
        <NavItem
          to="/comments"
          label="Comments"
          icon={<MessageSquareQuote size={18} />}
          count={3}
          countTone="attention"
        />
        <NavItem to="/notifications" label="Notifications" icon={<Bell size={18} />} />
      </Pane>
    </MemoryRouter>
  ),
};
