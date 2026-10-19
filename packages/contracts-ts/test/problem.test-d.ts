import { describe, expectTypeOf, it } from 'vitest';
import type { FieldError, Problem, ProblemCode } from '../src/index.ts';

describe('Problem', () => {
  it('exposes the stable code union by name', () => {
    expectTypeOf<ProblemCode>().toEqualTypeOf<Problem['code']>();
    expectTypeOf<'not_found'>().toExtend<ProblemCode>();
    expectTypeOf<'teapot'>().not.toExtend<ProblemCode>();
  });

  it('requires the RFC 9457 members', () => {
    expectTypeOf<Problem['type']>().toEqualTypeOf<string>();
    expectTypeOf<Problem['status']>().toEqualTypeOf<number>();
    expectTypeOf<Problem['errors']>().toEqualTypeOf<FieldError[] | undefined>();
  });
});
