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
    expect(el.style.fontSize).toBe('var(--sam-type-page-title-size)');
    expect(el.style.fontWeight).toBe('var(--sam-type-page-title-weight)');
    expect(el.style.lineHeight).toBe('var(--sam-type-page-title-line-height)');
  });

  it('merges custom style and className', () => {
    render(<PageTitle style={{ color: 'red' }} className="custom">Title</PageTitle>);
    const el = screen.getByRole('heading', { level: 1 });
    expect(el.style.color).toBe('red');
    expect(el.className).toBe('custom');
  });
});

describe('SectionHeading', () => {
  it('renders an h2 with section-heading token styles', () => {
    render(<SectionHeading>Overview</SectionHeading>);
    const el = screen.getByRole('heading', { level: 2, name: 'Overview' });
    expect(el.style.fontSize).toBe('var(--sam-type-section-heading-size)');
    expect(el.style.fontWeight).toBe('var(--sam-type-section-heading-weight)');
    expect(el.style.lineHeight).toBe('var(--sam-type-section-heading-line-height)');
  });
});

describe('CardTitle', () => {
  it('renders an h3 with card-title token styles', () => {
    render(<CardTitle>Workspace Info</CardTitle>);
    const el = screen.getByRole('heading', { level: 3, name: 'Workspace Info' });
    expect(el.style.fontSize).toBe('var(--sam-type-card-title-size)');
    expect(el.style.fontWeight).toBe('var(--sam-type-card-title-weight)');
    expect(el.style.lineHeight).toBe('var(--sam-type-card-title-line-height)');
  });
});

describe('Body', () => {
  it('renders a p with body token styles', () => {
    render(<Body>Some body text here.</Body>);
    const el = screen.getByText('Some body text here.');
    expect(el.tagName).toBe('P');
    expect(el.style.fontSize).toBe('var(--sam-type-body-size)');
    expect(el.style.fontWeight).toBe('var(--sam-type-body-weight)');
    expect(el.style.lineHeight).toBe('var(--sam-type-body-line-height)');
    expect(el.style.color).toBe('var(--sam-color-fg-primary)');
  });
});

describe('Secondary', () => {
  it('renders a p with secondary token styles and muted color', () => {
    render(<Secondary>Secondary text</Secondary>);
    const el = screen.getByText('Secondary text');
    expect(el.tagName).toBe('P');
    expect(el.style.fontSize).toBe('var(--sam-type-secondary-size)');
    expect(el.style.fontWeight).toBe('var(--sam-type-secondary-weight)');
    expect(el.style.lineHeight).toBe('var(--sam-type-secondary-line-height)');
    expect(el.style.color).toBe('var(--sam-color-fg-muted)');
  });
});

describe('Caption', () => {
  it('renders a span with caption token styles and muted color', () => {
    render(<Caption>Updated 2 hours ago</Caption>);
    const el = screen.getByText('Updated 2 hours ago');
    expect(el.tagName).toBe('SPAN');
    expect(el.style.fontSize).toBe('var(--sam-type-caption-size)');
    expect(el.style.fontWeight).toBe('var(--sam-type-caption-weight)');
    expect(el.style.lineHeight).toBe('var(--sam-type-caption-line-height)');
    expect(el.style.color).toBe('var(--sam-color-fg-muted)');
  });

  it('merges custom style', () => {
    render(<Caption style={{ marginLeft: '8px' }}>Note</Caption>);
    const el = screen.getByText('Note');
    expect(el.style.marginLeft).toBe('8px');
    // Token styles still applied
    expect(el.style.fontSize).toBe('var(--sam-type-caption-size)');
  });
});
