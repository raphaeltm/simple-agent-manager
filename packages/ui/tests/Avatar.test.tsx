import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Avatar } from '../src/components/Avatar';

describe('Avatar', () => {
  it('renders accessible initials from a display name', () => {
    render(<Avatar name="Ada Lovelace" />);

    const avatar = screen.getByLabelText('Ada Lovelace');
    expect(avatar).toHaveTextContent('AL');
    expect(avatar).toHaveAttribute('title', 'Ada Lovelace');
  });

  it('uses an empty image alt for decorative images', () => {
    render(<Avatar name="Grace" imageUrl="/avatar.png" tone="agent" />);

    const avatar = screen.getByLabelText('Grace');
    expect(avatar.querySelector('img')).toHaveAttribute('alt', '');
  });

  it('labels unknown authors without exposing an empty name', () => {
    render(<Avatar name={null} />);

    expect(screen.getByLabelText('Unknown author')).toHaveTextContent('?');
  });
});
