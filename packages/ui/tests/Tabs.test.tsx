import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { Tabs, type Tab } from '../src/components/Tabs';

const tabs: Tab[] = [
  { id: 'overview', label: 'Overview', path: 'overview' },
  { id: 'tasks', label: 'Tasks', path: 'tasks' },
  { id: 'settings', label: 'Settings', path: 'settings' },
];

function renderTabs(initialPath = '/projects/123/overview') {
  return render(
    <MemoryRouter initialEntries={[initialPath]}>
      <Tabs tabs={tabs} basePath="/projects/123" />
    </MemoryRouter>,
  );
}

describe('Tabs', () => {
  it('renders all tabs with correct labels', () => {
    renderTabs();
    expect(screen.getByText('Overview')).toBeInTheDocument();
    expect(screen.getByText('Tasks')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
  });

  it('renders a tablist role container', () => {
    renderTabs();
    expect(screen.getByRole('tablist')).toBeInTheDocument();
  });

  it('renders each tab with tab role', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    expect(tabElements).toHaveLength(3);
  });

  it('marks active tab with aria-selected=true', () => {
    renderTabs('/projects/123/overview');
    const overviewTab = screen.getByText('Overview');
    expect(overviewTab).toHaveAttribute('aria-selected', 'true');
  });

  it('marks inactive tabs with aria-selected=false', () => {
    renderTabs('/projects/123/overview');
    const tasksTab = screen.getByText('Tasks');
    expect(tasksTab).toHaveAttribute('aria-selected', 'false');
  });

  it('renders NavLink elements with correct href', () => {
    renderTabs();
    const overviewTab = screen.getByText('Overview');
    expect(overviewTab.closest('a')).toHaveAttribute('href', '/projects/123/overview');
  });

  it('sets tabIndex=0 on active tab and -1 on inactive', () => {
    renderTabs('/projects/123/tasks');
    const tasksTab = screen.getByText('Tasks');
    const overviewTab = screen.getByText('Overview');
    expect(tasksTab).toHaveAttribute('tabindex', '0');
    expect(overviewTab).toHaveAttribute('tabindex', '-1');
  });

  it('moves focus with ArrowRight key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[0].focus();

    fireEvent.keyDown(tabElements[0], { key: 'ArrowRight' });
    expect(tabElements[1]).toHaveFocus();
  });

  it('moves focus with ArrowLeft key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[1].focus();

    fireEvent.keyDown(tabElements[1], { key: 'ArrowLeft' });
    expect(tabElements[0]).toHaveFocus();
  });

  it('wraps focus with ArrowRight from last tab', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[2].focus();

    fireEvent.keyDown(tabElements[2], { key: 'ArrowRight' });
    expect(tabElements[0]).toHaveFocus();
  });

  it('moves focus to first tab with Home key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[2].focus();

    fireEvent.keyDown(tabElements[2], { key: 'Home' });
    expect(tabElements[0]).toHaveFocus();
  });

  it('moves focus to last tab with End key', () => {
    renderTabs();
    const tabElements = screen.getAllByRole('tab');
    tabElements[0].focus();

    fireEvent.keyDown(tabElements[0], { key: 'End' });
    expect(tabElements[2]).toHaveFocus();
  });

  it('matches sub-routes as active', () => {
    renderTabs('/projects/123/tasks/456');
    const tasksTab = screen.getByText('Tasks');
    expect(tasksTab).toHaveAttribute('aria-selected', 'true');
  });
});
