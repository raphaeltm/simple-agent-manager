import { describe, expect, it } from 'vitest';

import {
  parseProjectDataRoutingGuardOutput,
  validateProjectDataRoutingGuard,
} from '../deploy/project-data-routing-guard';

describe('ProjectData routing deploy guard', () => {
  it('allows an empty or fully compatible authoritative set', () => {
    expect(() =>
      validateProjectDataRoutingGuard({ authoritative_non_root: 4, incompatible: 0 })
    ).not.toThrow();
  });

  it('blocks an unsafe deploy when any authoritative pointer is incompatible', () => {
    expect(() =>
      validateProjectDataRoutingGuard({ authoritative_non_root: 4, incompatible: 1 })
    ).toThrow(/Unsafe deploy blocked/);
  });

  it('parses one framed JSON value and ignores trailing Wrangler diagnostics', () => {
    expect(
      parseProjectDataRoutingGuardOutput(`\n[
        {"results":[{"authoritative_non_root":0,"incompatible":0}]}
      ]\nwrangler diagnostic: retry metadata`)
    ).toEqual({ authoritative_non_root: 0, incompatible: 0 });
  });

  it('rejects malformed or incomplete Wrangler output', () => {
    expect(() => parseProjectDataRoutingGuardOutput('diagnostic only')).toThrow(/begin with JSON/);
    expect(() => parseProjectDataRoutingGuardOutput('wrangler frame\n[{"results":[]}]')).toThrow(
      /begin with JSON/
    );
    expect(() => parseProjectDataRoutingGuardOutput('[{"results":')).toThrow(/incomplete JSON/);
  });
});
