import { describe, expect, it } from 'vitest';

import { buildCronContext, renderTemplate } from '../../../src/services/trigger-template';

// =============================================================================
// renderTemplate
// =============================================================================

describe('renderTemplate', () => {
  it('interpolates simple top-level variables', () => {
    const result = renderTemplate('Hello {{name}}!', { name: 'World' });
    expect(result.rendered).toBe('Hello World!');
    expect(result.warnings).toHaveLength(0);
  });

  it('interpolates nested path variables', () => {
    const result = renderTemplate('Time: {{schedule.time}}', {
      schedule: { time: '2026-04-09T09:00:00Z' },
    });
    expect(result.rendered).toBe('Time: 2026-04-09T09:00:00Z');
    expect(result.warnings).toHaveLength(0);
  });

  it('interpolates deeply nested paths', () => {
    const result = renderTemplate('{{a.b.c.d}}', {
      a: { b: { c: { d: 'deep' } } },
    });
    expect(result.rendered).toBe('deep');
  });

  it('replaces missing variables with empty string and warns', () => {
    const result = renderTemplate('Hello {{missing}}!', {});
    expect(result.rendered).toBe('Hello !');
    expect(result.warnings).toContain('Missing variable: {{missing}}');
  });

  it('warns for partially resolved nested paths', () => {
    const result = renderTemplate('{{a.b.c}}', { a: { b: 'not-an-object' } });
    expect(result.rendered).toBe('');
    expect(result.warnings).toContain('Missing variable: {{a.b.c}}');
  });

  it('handles null context values', () => {
    const result = renderTemplate('{{val}}', { val: null });
    expect(result.rendered).toBe('');
    expect(result.warnings).toContain('Missing variable: {{val}}');
  });

  it('handles multiple variables in one template', () => {
    const result = renderTemplate(
      '{{trigger.name}} fired at {{schedule.time}} for {{project.name}}',
      {
        trigger: { name: 'Daily Check' },
        schedule: { time: '09:00' },
        project: { name: 'My Project' },
      }
    );
    expect(result.rendered).toBe('Daily Check fired at 09:00 for My Project');
    expect(result.warnings).toHaveLength(0);
  });

  it('preserves text outside of template variables', () => {
    const result = renderTemplate('No variables here.', {});
    expect(result.rendered).toBe('No variables here.');
    expect(result.warnings).toHaveLength(0);
  });

  it('handles whitespace in variable paths', () => {
    const result = renderTemplate('{{ schedule.time }}', {
      schedule: { time: '09:00' },
    });
    expect(result.rendered).toBe('09:00');
  });

  it('sanitizes HTML in interpolated values', () => {
    const result = renderTemplate('{{val}}', { val: '<script>alert("xss")</script>' });
    expect(result.rendered).toBe('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
    expect(result.rendered).not.toContain('<script>');
  });

  it('sanitizes ampersands in interpolated values', () => {
    const result = renderTemplate('{{val}}', { val: 'a & b' });
    expect(result.rendered).toBe('a &amp; b');
  });

  it('sanitizes single quotes in interpolated values', () => {
    const result = renderTemplate('{{val}}', { val: "it's" });
    expect(result.rendered).toContain('&#x27;');
  });

  it('does not process triple-braces as unescaped', () => {
    const result = renderTemplate('{{{val}}}', { val: '<b>bold</b>' });
    // The inner {{val}} gets replaced, outer braces remain
    expect(result.rendered).toContain('&lt;b&gt;');
  });

  it('truncates fields exceeding maxFieldLength', () => {
    const longValue = 'x'.repeat(3000);
    const result = renderTemplate('{{val}}', { val: longValue }, 8000, 2000);
    expect(result.rendered.length).toBeLessThanOrEqual(2000);
    expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('truncates total output exceeding maxLength', () => {
    const template = 'prefix-' + '{{val}}'.repeat(100);
    const result = renderTemplate(template, { val: 'x'.repeat(100) }, 500);
    expect(result.rendered.length).toBeLessThanOrEqual(500);
    expect(result.warnings.some((w) => w.includes('truncated'))).toBe(true);
  });

  it('converts numbers to strings', () => {
    const result = renderTemplate('Count: {{count}}', { count: 42 });
    expect(result.rendered).toBe('Count: 42');
  });

  it('converts booleans to strings', () => {
    const result = renderTemplate('Active: {{active}}', { active: true });
    expect(result.rendered).toBe('Active: true');
  });

  it('handles empty template', () => {
    const result = renderTemplate('', { val: 'test' });
    expect(result.rendered).toBe('');
  });
});

// =============================================================================
// buildCronContext
// =============================================================================

describe('buildCronContext', () => {
  const trigger = {
    id: 'trigger-1',
    name: 'Daily Standup',
    description: 'Check on project status',
    triggerCount: 5,
    cronTimezone: 'UTC',
    projectId: 'project-1',
  };

  const now = new Date('2026-04-09T09:00:00Z');

  it('builds a complete context object', () => {
    const ctx = buildCronContext(trigger, now, 'My Project', 'exec-1', 6);

    expect(ctx.schedule.time).toBe('2026-04-09T09:00:00.000Z');
    expect(ctx.schedule.date).toBe('2026-04-09');
    expect(ctx.schedule.dayOfWeek).toBe('Thursday');
    expect(ctx.schedule.hour).toBe('09');
    expect(ctx.schedule.minute).toBe('00');
    expect(ctx.schedule.timezone).toBe('UTC');

    expect(ctx.trigger.id).toBe('trigger-1');
    expect(ctx.trigger.name).toBe('Daily Standup');
    expect(ctx.trigger.description).toBe('Check on project status');
    expect(ctx.trigger.fireCount).toBe('6'); // triggerCount + 1

    expect(ctx.project.id).toBe('project-1');
    expect(ctx.project.name).toBe('My Project');

    expect(ctx.execution.id).toBe('exec-1');
    expect(ctx.execution.sequenceNumber).toBe('6');
  });

  it('handles null description', () => {
    const ctx = buildCronContext(
      { ...trigger, description: null },
      now,
      'Test',
      'exec-1',
      1
    );
    expect(ctx.trigger.description).toBe('');
  });

  it('handles different timezones', () => {
    const ctx = buildCronContext(
      { ...trigger, cronTimezone: 'America/New_York' },
      now,
      'Test',
      'exec-1',
      1
    );
    expect(ctx.schedule.timezone).toBe('America/New_York');
    // 9 AM UTC = 5 AM ET (EDT)
    expect(ctx.schedule.hour).toBe('05');
  });

  it('all values are strings (for template interpolation)', () => {
    const ctx = buildCronContext(trigger, now, 'Test', 'exec-1', 42);

    // Check all leaf values are strings
    for (const group of Object.values(ctx)) {
      for (const value of Object.values(group)) {
        expect(typeof value).toBe('string');
      }
    }
  });

  it('increments fire count correctly', () => {
    const ctx = buildCronContext(
      { ...trigger, triggerCount: 0 },
      now,
      'Test',
      'exec-1',
      1
    );
    expect(ctx.trigger.fireCount).toBe('1');
  });

  it('can be used with renderTemplate for end-to-end rendering', () => {
    const ctx = buildCronContext(trigger, now, 'My Project', 'exec-1', 6);
    const template = 'Run daily check for {{project.name}} (fire #{{trigger.fireCount}}) at {{schedule.time}}';
    const result = renderTemplate(template, ctx as unknown as Record<string, unknown>);
    expect(result.rendered).toContain('My Project');
    expect(result.rendered).toContain('fire #6');
    expect(result.rendered).toContain('2026-04-09');
    expect(result.warnings).toHaveLength(0);
  });
});
