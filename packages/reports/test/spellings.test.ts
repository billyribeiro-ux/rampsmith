// The vocabulary must spell every value exactly as crates/domain does, in the same order.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FINDING_STATUSES,
  FIX_CHANNELS,
  FIX_KINDS,
  FIX_ORIGINS,
  FIX_STATUSES,
  IMPACTS,
  PLATFORMS,
  SCAN_STATUSES,
  channelCarries,
  scanHasResults,
} from '../src/vocabulary.ts';

const DOMAIN = join(import.meta.dirname, '..', '..', '..', 'crates', 'domain', 'src');

/** The `"spelling"` literals of one `string_enum!` block in enums.rs, in declaration order. */
function rustEnum(name: string): string[] {
  const source = readFileSync(join(DOMAIN, 'enums.rs'), 'utf8');
  const start = source.indexOf(`pub enum ${name} {`);
  expect(start, `enum ${name} in enums.rs`).toBeGreaterThan(-1);
  const body = source.slice(start, source.indexOf('\n    }\n', start));
  return [...body.matchAll(/=> "([a-z_]+)"/gu)].map((m) => m[1] ?? '');
}

describe('spellings match crates/domain', () => {
  it.each([
    ['FindingStatus', FINDING_STATUSES],
    ['FixKind', FIX_KINDS],
    ['FixChannel', FIX_CHANNELS],
    ['FixStatus', FIX_STATUSES],
    ['FixOrigin', FIX_ORIGINS],
    ['ScanStatus', SCAN_STATUSES],
    ['Platform', PLATFORMS],
  ] as const)('%s', (name, values) => {
    expect([...values]).toEqual(rustEnum(name));
  });

  it('Impact, least severe first', () => {
    const source = readFileSync(join(DOMAIN, 'impact.rs'), 'utf8');
    const spellings = [...source.matchAll(/Self::\w+ => "([a-z]+)"/gu)].map((m) => m[1] ?? '');
    expect([...IMPACTS]).toEqual(spellings);
  });
});

describe('domain rules mirrored here', () => {
  it('only data fixes go through the Admin API (FixChannel::carries)', () => {
    expect(channelCarries('admin_api', 'data')).toBe(true);
    expect(channelCarries('admin_api', 'code')).toBe(false);
    expect(channelCarries('github_pr', 'code')).toBe(true);
    expect(channelCarries('theme_package', 'code')).toBe(true);
    expect(channelCarries('github_pr', 'data')).toBe(false);
    expect(channelCarries('theme_package', 'data')).toBe(false);
  });

  it('only finished scans with checked pages carry results', () => {
    expect(SCAN_STATUSES.filter(scanHasResults)).toEqual(['succeeded', 'partial']);
  });
});
