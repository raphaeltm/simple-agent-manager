import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import {
  PageTitle,
  SectionHeading,
  CardTitle,
  Body,
  Secondary,
  Caption,
} from '../src/primitives/Typography';

describe('PageTitle', () => {
  it('renders an h1 with page-title token styles', () => {
    render(<PageTitle>Dashboard</PageTitle>);
    const el = screen.getByRole('heading', { level: 1, name: 'Dashboard' });
    expect(el.className).toContain('sam-type-page-title');
    expect(el.className).toContain('text-fg-primary');
  });

  it('merges custom style and className', () => {
    render(<PageTitle style={{ color: 'red' }} className="custom">Title</PageTitle>);
    const el = screen.getByRole('heading', { level: 1 });
    expect(el.style.color).toBe('red');
    expect(el.className).toContain('custom');
  });
});

describe('SectionHeading', () => {
  it('renders an h2 with section-heading token styles', () => {
    render(<SectionHeading>Overview</SectionHeading>);
    const el = screen.getByRole('heading', { level: 2, name: 'Overview' });
    expect(el.className).toContain('sam-type-section-heading');
    expect(el.className).toContain('text-fg-primary');
  });
});

describe('CardTitle', () => {
  it('renders an h3 with card-title token styles', () => {
    render(<CardTitle>Workspace Info</CardTitle>);
    const el = screen.getByRole('heading', { level: 3, name: 'Workspace Info' });
    expect(el.className).toContain('sam-type-card-title');
    expect(el.className).toContain('text-fg-primary');
  });
});

describe('Body', () => {
  it('renders a p with body token styles', () => {
    render(<Body>Some body text here.</Body>);
    const el = screen.getByText('Some body text here.');
    expect(el.tagName).toBe('P');
    expect(el.className).toContain('sam-type-body');
    expect(el.className).toContain('text-fg-primary');
  });
});

describe('Secondary', () => {
  it('renders a p with secondary token styles and muted color', () => {
    render(<Secondary>Secondary text</Secondary>);
    const el = screen.getByText('Secondary text');
    expect(el.tagName).toBe('P');
    expect(el.className).toContain('sam-type-secondary');
    expect(el.className).toContain('text-fg-muted');
  });
});

describe('Caption', () => {
  it('renders a span with caption token styles and muted color', () => {
    render(<Caption>Updated 2 hours ago</Caption>);
    const el = screen.getByText('Updated 2 hours ago');
    expect(el.tagName).toBe('SPAN');
    expect(el.className).toContain('sam-type-caption');
    expect(el.className).toContain('text-fg-muted');
  });

  it('merges custom style', () => {
    render(<Caption style={{ marginLeft: '8px' }}>Note</Caption>);
    const el = screen.getByText('Note');
    expect(el.style.marginLeft).toBe('8px');
    expect(el.className).toContain('sam-type-caption');
  });
});
