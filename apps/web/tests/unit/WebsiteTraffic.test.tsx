import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { WebsiteTraffic } from '../../src/pages/admin-analytics/WebsiteTraffic';
import type { AnalyticsWebsiteTrafficResponse } from '../../src/lib/api';

describe('WebsiteTraffic component', () => {
  it('renders empty state when data is null', () => {
    render(<WebsiteTraffic data={null} />);
    expect(screen.getByText(/no website traffic data/i)).toBeDefined();
  });

  it('renders empty state when hosts array is empty', () => {
    const data: AnalyticsWebsiteTrafficResponse = {
      hosts: [],
      trend: [],
      period: '7d',
    };
    render(<WebsiteTraffic data={data} />);
    expect(screen.getByText(/no website traffic data/i)).toBeDefined();
  });

  it('renders host name and totals', () => {
    const data: AnalyticsWebsiteTrafficResponse = {
      hosts: [
        {
          host: 'www.simple-agent-manager.org',
          totalViews: 1234,
          uniqueVisitors: 567,
          uniqueSessions: 890,
          sections: [
            {
              name: 'blog',
              views: 500,
              unique_visitors: 200,
              topPages: [
                { page: '/blog/post-1', views: 300, unique_visitors: 150 },
                { page: '/blog/post-2', views: 200, unique_visitors: 100 },
              ],
            },
            {
              name: 'docs',
              views: 400,
              unique_visitors: 180,
              topPages: [
                { page: '/docs/overview', views: 400, unique_visitors: 180 },
              ],
            },
          ],
        },
      ],
      trend: [],
      period: '7d',
    };
    render(<WebsiteTraffic data={data} />);

    // Host name should appear
    expect(screen.getByText('www.simple-agent-manager.org')).toBeDefined();

    // Section labels should appear
    expect(screen.getByText('Blog')).toBeDefined();
    expect(screen.getByText('Documentation')).toBeDefined();

    // Top pages should appear
    expect(screen.getByText('/blog/post-1')).toBeDefined();
    expect(screen.getByText('/docs/overview')).toBeDefined();
  });

  it('renders multiple hosts', () => {
    const data: AnalyticsWebsiteTrafficResponse = {
      hosts: [
        {
          host: 'www.example.com',
          totalViews: 100,
          uniqueVisitors: 50,
          uniqueSessions: 60,
          sections: [],
        },
        {
          host: 'app.example.com',
          totalViews: 200,
          uniqueVisitors: 80,
          uniqueSessions: 90,
          sections: [],
        },
      ],
      trend: [],
      period: '7d',
    };
    render(<WebsiteTraffic data={data} />);

    expect(screen.getByText('www.example.com')).toBeDefined();
    expect(screen.getByText('app.example.com')).toBeDefined();
  });

  it('renders "No section data" when host has empty sections', () => {
    const data: AnalyticsWebsiteTrafficResponse = {
      hosts: [
        {
          host: 'empty.example.com',
          totalViews: 10,
          uniqueVisitors: 5,
          uniqueSessions: 5,
          sections: [],
        },
      ],
      trend: [],
      period: '7d',
    };
    render(<WebsiteTraffic data={data} />);

    expect(screen.getByText('No section data')).toBeDefined();
  });

  it('renders section bars with correct aria labels', () => {
    const data: AnalyticsWebsiteTrafficResponse = {
      hosts: [
        {
          host: 'www.example.com',
          totalViews: 100,
          uniqueVisitors: 50,
          uniqueSessions: 60,
          sections: [
            {
              name: 'landing',
              views: 100,
              unique_visitors: 50,
              topPages: [],
            },
          ],
        },
      ],
      trend: [],
      period: '7d',
    };
    render(<WebsiteTraffic data={data} />);

    const bar = screen.getByRole('img', { name: /Landing Page: 100 views, 50 visitors/ });
    expect(bar).toBeDefined();
  });
});
