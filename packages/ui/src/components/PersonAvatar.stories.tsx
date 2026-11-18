import type { Meta, StoryObj } from '@storybook/react';

import { Pane } from './Pane';
import { AvatarStack, PersonAvatar } from './PersonAvatar';

const meta: Meta<typeof PersonAvatar> = {
  title: 'SAM Glass/PersonAvatar',
  component: PersonAvatar,
};

export default meta;
type Story = StoryObj<typeof PersonAvatar>;

/** You in green, teammates in cyan, violet and rose, automations in grey; solid, never faded. */
export const People: Story = {
  render: () => (
    <Pane className="flex items-center gap-3 p-4">
      <PersonAvatar name="Raphaël Titsworth-Morin" person="you" size={32} />
      <PersonAvatar name="Maya Chen" person={1} />
      <PersonAvatar name="Jonas Weber" person={2} size={20} />
      <PersonAvatar name="Priya Anand" person={3} selected />
      <PersonAvatar name="Automation" person="auto" size={14} />
      <AvatarStack
        label="Shared with Maya Chen, Jonas Weber, Priya Anand"
        size={26}
        people={[
          { id: 'maya', name: 'Maya Chen', slot: 1 },
          { id: 'jonas', name: 'Jonas Weber', slot: 2 },
          { id: 'priya', name: 'Priya Anand', slot: 3 },
        ]}
      />
    </Pane>
  ),
};
