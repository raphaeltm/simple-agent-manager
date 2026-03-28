import { type FC, useState, useMemo } from 'react';
import { Body } from '@simple-agent-manager/ui';
import {
  ComposableMap,
  Geographies,
  Geography,
  ZoomableGroup,
} from 'react-simple-maps';
import { scaleLinear } from 'd3-scale';
import type { AnalyticsGeoResponse } from '../../lib/api';

// TopoJSON world atlas — lightweight 110m resolution
const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json';

/**
 * ISO 3166-1 alpha-2 to alpha-3 mapping for countries commonly seen in analytics.
 * react-simple-maps uses alpha-3 (ISO_A3) by default in the world atlas.
 * We map from alpha-2 (what Cloudflare provides) to alpha-3 (what the map uses).
 */
const ALPHA2_TO_ALPHA3: Record<string, string> = {
  US: 'USA', DE: 'DEU', GB: 'GBR', FR: 'FRA', JP: 'JPN', CA: 'CAN',
  AU: 'AUS', BR: 'BRA', IN: 'IND', NL: 'NLD', SE: 'SWE', SG: 'SGP',
  CH: 'CHE', ES: 'ESP', IT: 'ITA', CN: 'CHN', KR: 'KOR', RU: 'RUS',
  MX: 'MEX', AR: 'ARG', ZA: 'ZAF', NG: 'NGA', EG: 'EGY', TH: 'THA',
  ID: 'IDN', PH: 'PHL', VN: 'VNM', PL: 'POL', CZ: 'CZE', AT: 'AUT',
  BE: 'BEL', DK: 'DNK', FI: 'FIN', NO: 'NOR', IE: 'IRL', PT: 'PRT',
  GR: 'GRC', HU: 'HUN', RO: 'ROU', IL: 'ISR', AE: 'ARE', SA: 'SAU',
  NZ: 'NZL', CL: 'CHL', CO: 'COL', PE: 'PER', UA: 'UKR', TW: 'TWN',
  MY: 'MYS', HK: 'HKG', PK: 'PAK', BD: 'BGD', KE: 'KEN', TR: 'TUR',
};

/** Country display names for common codes. */
const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', DE: 'Germany', GB: 'United Kingdom', FR: 'France',
  JP: 'Japan', CA: 'Canada', AU: 'Australia', BR: 'Brazil', IN: 'India',
  NL: 'Netherlands', SE: 'Sweden', SG: 'Singapore', CH: 'Switzerland',
  ES: 'Spain', IT: 'Italy', CN: 'China', KR: 'South Korea', RU: 'Russia',
  MX: 'Mexico', AR: 'Argentina', ZA: 'South Africa', NZ: 'New Zealand',
  IE: 'Ireland', NO: 'Norway', DK: 'Denmark', FI: 'Finland', PL: 'Poland',
  PT: 'Portugal', BE: 'Belgium', AT: 'Austria', CZ: 'Czechia', IL: 'Israel',
  AE: 'UAE', SA: 'Saudi Arabia', TR: 'Turkey', TW: 'Taiwan', HK: 'Hong Kong',
};

interface Props {
  data: AnalyticsGeoResponse | null;
}

export const GeoDistribution: FC<Props> = ({ data }) => {
  const [hoveredCountry, setHoveredCountry] = useState<string | null>(null);

  const { countryMap, maxUsers, totalUsers, colorScale } = useMemo(() => {
    const map = new Map<string, { unique_users: number; event_count: number }>();
    let max = 1;
    let total = 0;
    for (const row of data?.geo ?? []) {
      const alpha3 = ALPHA2_TO_ALPHA3[row.country] ?? row.country;
      map.set(alpha3, { unique_users: row.unique_users, event_count: row.event_count });
      map.set(row.country, { unique_users: row.unique_users, event_count: row.event_count });
      max = Math.max(max, row.unique_users);
      total += row.unique_users;
    }
    const scale = scaleLinear<string>()
      .domain([0, max])
      .range(['var(--sam-color-bg-surface, #13201d)', 'var(--sam-color-accent-primary, #16a34a)']);
    return { countryMap: map, maxUsers: max, totalUsers: total, colorScale: scale };
  }, [data]);

  if (!data?.geo?.length) {
    return <Body className="text-fg-muted">No geographic data available yet.</Body>;
  }

  return (
    <div className="flex flex-col gap-4">
      {/* World map */}
      <div className="w-full rounded-lg border border-border-default overflow-hidden" style={{ height: 300 }}>
        <ComposableMap
          projection="geoMercator"
          projectionConfig={{ scale: 120, center: [0, 30] }}
          style={{ width: '100%', height: '100%' }}
        >
          <ZoomableGroup>
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map((geo) => {
                  const alpha3 = geo.properties.ISO_A3 ?? geo.id;
                  const match = countryMap.get(alpha3);
                  const isHovered = hoveredCountry === alpha3;

                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      fill={match ? colorScale(match.unique_users) : 'var(--sam-color-bg-inset, #0e1a17)'}
                      stroke="var(--sam-color-border-default, #29423b)"
                      strokeWidth={isHovered ? 1.5 : 0.5}
                      style={{
                        default: { outline: 'none' },
                        hover: { outline: 'none', fill: match ? 'var(--sam-color-success, #22c55e)' : 'var(--sam-color-bg-surface-hover, #1a2e29)' },
                        pressed: { outline: 'none' },
                      }}
                      onMouseEnter={() => setHoveredCountry(alpha3)}
                      onMouseLeave={() => setHoveredCountry(null)}
                    />
                  );
                })
              }
            </Geographies>
          </ZoomableGroup>
        </ComposableMap>
      </div>

      {/* Country table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-default text-left text-fg-muted">
              <th scope="col" className="py-2 pr-4 font-medium">Country</th>
              <th scope="col" className="py-2 pr-4 font-medium text-right">Users</th>
              <th scope="col" className="py-2 pr-4 font-medium text-right">Events</th>
              <th scope="col" className="py-2 font-medium text-right">Share</th>
            </tr>
          </thead>
          <tbody>
            {data.geo.map((row) => {
              const share = totalUsers > 0 ? Math.round((row.unique_users / totalUsers) * 100) : 0;
              const name = COUNTRY_NAMES[row.country] ?? row.country;
              const barWidth = Math.max((row.unique_users / maxUsers) * 100, 3);

              return (
                <tr key={row.country} className="border-b border-border-muted">
                  <td className="py-2 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-fg-muted w-6">{row.country}</span>
                      <span className="text-fg-secondary">{name}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-20 h-3 bg-surface-secondary rounded-sm overflow-hidden hidden sm:block">
                        <div
                          className="h-full rounded-sm"
                          style={{
                            width: `${barWidth}%`,
                            backgroundColor: 'var(--sam-color-accent-primary, #16a34a)',
                          }}
                        />
                      </div>
                      <span className="tabular-nums">{row.unique_users.toLocaleString()}</span>
                    </div>
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums text-fg-muted">
                    {row.event_count.toLocaleString()}
                  </td>
                  <td className="py-2 text-right tabular-nums text-fg-muted">{share}%</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
