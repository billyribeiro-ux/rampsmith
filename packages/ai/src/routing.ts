/**
 * Model routing (PLAN §13 "Model routing"; ADR-011, ADR-212). Each task runs on the cheapest
 * model that passes its evaluation, with an effort level and thinking mode the model accepts.
 * The routes are data, so a model review changes one table and the evaluation gate decides.
 */
import type { ThinkingConfigParam } from '@anthropic-ai/sdk/resources/messages/messages';
import type { CallMode } from './cost.ts';
import type { Effort, ModelId, ThinkingMode } from './models.ts';

export const TASKS = [
  'alt_text',
  'alt_text_escalated',
  'rewrite',
  'tie_break',
  'patch_proposal',
  'explain',
  'grade_alt_text',
] as const;

export type Task = (typeof TASKS)[number];

export interface Route {
  readonly task: Task;
  readonly model: ModelId;
  /** The default mode; `routeFor` switches tasks someone waits on to `sync`. */
  readonly mode: CallMode;
  /** Whether a waiting merchant moves the task to a synchronous call. */
  readonly interactiveSync: boolean;
  readonly effort: Effort;
  readonly thinking: ThinkingMode;
  /** A hard limit on thinking plus response text. */
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly cacheTtl: '5m' | '1h';
}

const SECOND = 1000;

export const ROUTES: Readonly<Record<Task, Route>> = {
  // Short structured answers: Haiku 5.5 with thinking off keeps output near the plan's
  // 60 tokens per image; Sonnet 5.5 takes the images Haiku flags.
  alt_text: {
    task: 'alt_text',
    model: 'claude-haiku-5-5',
    mode: 'batch',
    interactiveSync: true,
    effort: 'low',
    thinking: 'disabled',
    maxTokens: 400,
    timeoutMs: 60 * SECOND,
    cacheTtl: '1h',
  },
  alt_text_escalated: {
    task: 'alt_text_escalated',
    model: 'claude-sonnet-5-5',
    mode: 'batch',
    interactiveSync: true,
    effort: 'low',
    thinking: 'between_tools',
    maxTokens: 600,
    timeoutMs: 90 * SECOND,
    cacheTtl: '1h',
  },
  rewrite: {
    task: 'rewrite',
    model: 'claude-sonnet-5-5',
    mode: 'batch',
    interactiveSync: true,
    effort: 'medium',
    thinking: 'between_tools',
    maxTokens: 4000,
    timeoutMs: 120 * SECOND,
    cacheTtl: '1h',
  },
  tie_break: {
    task: 'tie_break',
    model: 'claude-sonnet-5-5',
    mode: 'sync',
    interactiveSync: true,
    effort: 'low',
    thinking: 'between_tools',
    maxTokens: 400,
    timeoutMs: 60 * SECOND,
    cacheTtl: '5m',
  },
  // Opus 5.5 always thinks; the Batch API keeps a long reasoning run off the 10-minute limit
  // for non-streaming requests and halves its price.
  patch_proposal: {
    task: 'patch_proposal',
    model: 'claude-opus-5-5',
    mode: 'batch',
    interactiveSync: false,
    effort: 'high',
    thinking: 'adaptive',
    maxTokens: 32_000,
    timeoutMs: 600 * SECOND,
    cacheTtl: '1h',
  },
  explain: {
    task: 'explain',
    model: 'claude-haiku-5-5',
    mode: 'batch',
    interactiveSync: false,
    effort: 'low',
    thinking: 'disabled',
    maxTokens: 1000,
    timeoutMs: 60 * SECOND,
    cacheTtl: '1h',
  },
  // The evaluation harness's unsupported-attribute check (PLAN §13 "Evaluation harness").
  grade_alt_text: {
    task: 'grade_alt_text',
    model: 'claude-sonnet-5-5',
    mode: 'sync',
    interactiveSync: true,
    effort: 'low',
    thinking: 'between_tools',
    maxTokens: 600,
    timeoutMs: 90 * SECOND,
    cacheTtl: '5m',
  },
};

/** The route for a task, synchronous when a merchant is waiting and the task allows it. */
export function routeFor(task: Task, options: { readonly interactive: boolean }): Route {
  const route = ROUTES[task];
  if (route.mode === 'batch' && options.interactive && route.interactiveSync) {
    return { ...route, mode: 'sync', cacheTtl: '5m' };
  }
  return route;
}

/** The request's `thinking` field; omitted for adaptive thinking, the API default. */
export function thinkingParam(route: Route): ThinkingConfigParam | undefined {
  switch (route.thinking) {
    case 'adaptive':
      return undefined;
    case 'disabled':
      return { type: 'disabled' };
    case 'between_tools':
      return { type: 'between_tools' };
  }
}
