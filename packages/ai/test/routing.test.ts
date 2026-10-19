import { describe, expect, it } from 'vitest';
import { acceptsThinking } from '../src/models.ts';
import { ROUTES, TASKS, routeFor, thinkingParam } from '../src/routing.ts';

describe('model routing (PLAN §13)', () => {
  it('routes each task to the model the plan names', () => {
    expect(ROUTES.alt_text.model).toBe('claude-haiku-5-5');
    expect(ROUTES.alt_text_escalated.model).toBe('claude-sonnet-5-5');
    expect(ROUTES.rewrite.model).toBe('claude-sonnet-5-5');
    expect(ROUTES.tie_break.model).toBe('claude-sonnet-5-5');
    expect(ROUTES.patch_proposal.model).toBe('claude-opus-5-5');
    expect(ROUTES.explain.model).toBe('claude-haiku-5-5');
    expect(ROUTES.grade_alt_text.model).toBe('claude-sonnet-5-5');
  });

  it('uses the Batch API where latency allows, synchronous calls where someone waits', () => {
    expect(routeFor('alt_text', { interactive: false }).mode).toBe('batch');
    expect(routeFor('alt_text', { interactive: true }).mode).toBe('sync');
    expect(routeFor('rewrite', { interactive: true }).mode).toBe('sync');
    expect(routeFor('rewrite', { interactive: false }).mode).toBe('batch');
    expect(routeFor('tie_break', { interactive: false }).mode).toBe('sync');
    expect(routeFor('patch_proposal', { interactive: true }).mode).toBe('batch');
  });

  it.each(TASKS)('%s uses a thinking mode its model accepts at its effort', (task) => {
    const route = ROUTES[task];
    expect(acceptsThinking(route.model, route.thinking, route.effort)).toBe(true);
    expect(route.maxTokens).toBeLessThanOrEqual(128_000);
  });

  it('turns thinking off where the model allows and omits the field for Opus', () => {
    expect(thinkingParam(ROUTES.alt_text)).toEqual({ type: 'disabled' });
    expect(thinkingParam(ROUTES.rewrite)).toEqual({ type: 'between_tools' });
    expect(thinkingParam(ROUTES.patch_proposal)).toBeUndefined();
  });

  it('caches the prefix for an hour in batches and five minutes in synchronous calls', () => {
    expect(routeFor('alt_text', { interactive: false }).cacheTtl).toBe('1h');
    expect(routeFor('alt_text', { interactive: true }).cacheTtl).toBe('5m');
  });
});
