import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/uuid.ts';

describe('uuidv7', () => {
  it('formats a version 7, RFC 9562 variant UUID', () => {
    const id = uuidv7();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('encodes the millisecond timestamp in the first 48 bits', () => {
    const at = Date.UTC(2026, 9, 17, 12, 0, 0, 123);
    const id = uuidv7(at);
    const ms = Number.parseInt(id.replaceAll('-', '').slice(0, 12), 16);
    expect(ms).toBe(at);
  });

  it('sorts later ids after earlier ones', () => {
    expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });
});
