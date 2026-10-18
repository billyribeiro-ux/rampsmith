// Snapshot of every rendered output. Each file sits in test/__snapshots__/ with a `.snap`
// suffix, so a reviewer reads the real HTML, text, CSV and JSON in the diff of any change.
import { describe, expect, it } from 'vitest';
import { outputs } from './support/outputs.ts';

describe('rendered outputs', () => {
  it.each(outputs().map((o) => [o.name, o.content] as const))('%s', async (name, content) => {
    await expect(content).toMatchFileSnapshot(`__snapshots__/${name}.snap`);
  });
});
