/**
 * Default OG image template for SAM website.
 *
 * Renders at 1200x630 (standard OG dimensions) with:
 * - Dark background matching the www site
 * - SAM icon (favicon SVG)
 * - Title text in Chillax
 * - Tagline
 * - Subtle green accent glow
 */

import type { TemplateConfig } from '../types.js';

// Brand tokens from apps/www/src/styles/global.css
const colors = {
  bgCanvas: '#0b1110',
  bgSurface: '#13201d',
  fgPrimary: '#e6f2ee',
  fgMuted: '#9fb7ae',
  fgDim: '#6b8a7f',
  accent: '#16a34a',
  accentHover: '#15803d',
  success: '#22c55e',
  border: '#29423b',
  borderSubtle: '#1e332d',
};

export const config: TemplateConfig = {
  width: 1200,
  height: 630,
};

export function render(opts?: { title?: string; subtitle?: string }) {
  const title = opts?.title ?? 'SAM';
  const subtitle =
    opts?.subtitle ??
    'Run coding agents in parallel on your infrastructure';

  return {
    type: 'div',
    props: {
      style: {
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: colors.bgCanvas,
        padding: '60px 80px',
        position: 'relative',
        overflow: 'hidden',
      },
      children: [
        // Background glow effect
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              top: '-100px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '800px',
              height: '400px',
              background:
                'radial-gradient(ellipse at center, rgba(22, 163, 74, 0.12) 0%, transparent 70%)',
            },
          },
        },
        // Bottom glow
        {
          type: 'div',
          props: {
            style: {
              position: 'absolute',
              bottom: '-150px',
              left: '50%',
              transform: 'translateX(-50%)',
              width: '600px',
              height: '300px',
              background:
                'radial-gradient(ellipse at center, rgba(22, 163, 74, 0.08) 0%, transparent 70%)',
            },
          },
        },
        // Main content card
        {
          type: 'div',
          props: {
            style: {
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '32px',
            },
            children: [
              // Icon row: terminal icon
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: '88px',
                    height: '88px',
                    borderRadius: '22px',
                    backgroundColor: colors.bgSurface,
                    border: `3px solid ${colors.border}`,
                  },
                  children: [
                    // Terminal prompt icon (> _) built with divs
                    {
                      type: 'div',
                      props: {
                        style: {
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'flex-start',
                          gap: '4px',
                        },
                        children: [
                          // Chevron >
                          {
                            type: 'div',
                            props: {
                              style: {
                                fontSize: '36px',
                                fontWeight: '700',
                                color: colors.accent,
                                lineHeight: '1',
                                fontFamily: 'monospace',
                              },
                              children: '>_',
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
              },
              // Title
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '96px',
                    fontWeight: '700',
                    fontFamily: 'Chillax',
                    letterSpacing: '-0.03em',
                    color: colors.fgPrimary,
                    lineHeight: '1',
                  },
                  children: title,
                },
              },
              // Subtitle
              {
                type: 'div',
                props: {
                  style: {
                    fontSize: '32px',
                    fontWeight: '400',
                    fontFamily: 'Chillax',
                    color: colors.fgMuted,
                    textAlign: 'center',
                    lineHeight: '1.4',
                    maxWidth: '900px',
                  },
                  children: subtitle,
                },
              },
              // Badge
              {
                type: 'div',
                props: {
                  style: {
                    display: 'flex',
                    alignItems: 'center',
                    gap: '10px',
                    marginTop: '8px',
                    padding: '8px 20px',
                    borderRadius: '100px',
                    border: `1px solid ${colors.border}`,
                    fontSize: '18px',
                    color: colors.fgDim,
                    fontFamily: 'monospace',
                  },
                  children: [
                    // Green dot
                    {
                      type: 'div',
                      props: {
                        style: {
                          width: '8px',
                          height: '8px',
                          borderRadius: '50%',
                          backgroundColor: colors.accent,
                        },
                      },
                    },
                    {
                      type: 'div',
                      props: {
                        children: 'Open Source & Self-Hosted',
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  };
}
