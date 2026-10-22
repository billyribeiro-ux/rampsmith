import { criteriaNames } from '#lib/app/criteria.server.ts';
import type { LayoutServerLoad } from './$types';

/** Public constants, not tenant data: the shell still carries nothing about a shop (ADR-022). */
export const load: LayoutServerLoad = () => ({ criteria: criteriaNames() });
