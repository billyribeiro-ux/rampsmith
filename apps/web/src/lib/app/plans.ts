import { m } from '#lib/paraglide/messages.js';
import type { PlanHandle } from './types.ts';

export function planLabel(plan: PlanHandle): string {
  return {
    free: m.app_plan_name_free(),
    starter: m.app_plan_name_starter(),
    growth: m.app_plan_name_growth(),
    pro: m.app_plan_name_pro(),
  }[plan];
}
