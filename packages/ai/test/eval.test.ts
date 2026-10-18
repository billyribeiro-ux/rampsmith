import {
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  APPROVAL_TARGET,
  BUNDLED_DATASET,
  RecordedTransport,
  approvedUneditedRate,
  formatReport,
  loadDataset,
  mentions,
  releaseGate,
  requestKey,
  runEval,
  scoreCandidate,
  selectRatingSample,
  summarize,
  summarizeRatings,
  type DatasetImage,
} from '../src/eval/index.ts';
import { prepareAltText } from '../src/tasks/alt-text.ts';

describe('the bundled dataset (openly licensed, small enough for the repository)', () => {
  const { manifest, images } = loadDataset();

  it('lists 20 labelled images across categories, each with two references', () => {
    expect(images).toHaveLength(20);
    expect(new Set(images.map((i) => i.category)).size).toBeGreaterThanOrEqual(12);
    expect(manifest.reference_note).toMatch(/human raters/u);
    for (const i of images) {
      expect(i.references).toHaveLength(2);
      if (!i.expected.decorative) {
        expect(i.required.length).toBeGreaterThan(0);
        expect(i.references.every((r) => r.length > 0 && r.length <= 150)).toBe(true);
      }
    }
  });

  it('records an open licence, author, source and modifications for every image', () => {
    for (const i of images) {
      expect(['CC0-1.0', 'CC-BY-2.0', 'LicenseRef-Public-Domain']).toContain(i.licence.spdx);
      expect(i.licence.author.length).toBeGreaterThan(0);
      expect(i.licence.source.length).toBeGreaterThan(0);
      expect(i.licence.obtained_from.length).toBeGreaterThan(0);
    }
  });

  it('keeps every image at most 448 px on its long edge and the set under 1 MB', () => {
    for (const i of images) {
      expect(Math.max(i.image.width, i.image.height)).toBeLessThanOrEqual(448);
    }
    const dir = new URL('images/', BUNDLED_DATASET);
    const files = readdirSync(dir);
    expect(files.sort()).toEqual(images.map((i) => i.file.replace('images/', '')).sort());
    const bytes = files.reduce((sum, f) => sum + statSync(new URL(f, dir)).size, 0);
    expect(bytes).toBeLessThan(1024 * 1024);
  });

  it('covers the cases the rules name: people, embedded text, decoration and an injection', () => {
    expect(images.filter((i) => i.expected.people).length).toBeGreaterThanOrEqual(2);
    expect(images.filter((i) => i.expected.contains_text).length).toBeGreaterThanOrEqual(3);
    expect(images.some((i) => i.expected.decorative)).toBe(true);
    expect(images.some((i) => i.expected.instruction_text)).toBe(true);
  });
});

describe('the recorded run (substitute for the live check, LAUNCH.md section E)', () => {
  it('runs the production pipeline over every image and computes the metrics', async () => {
    const report = await runEval({ mode: 'recorded' });
    const s = report.summary;
    expect(report.promptVersion).toBe('alt-text@1');
    expect(s.images).toBe(20);
    expect(s.failed).toBe(0);
    expect(s.approvable).toBe(18);
    expect(s.approvalRate).toBe(0.9);
    expect(s.unsupportedRate).toBe(0);
    expect(s.namedPeople).toBe(0);
    expect(s.escalationRate).toBe(0.25);
    expect(s.gate).toEqual({ passed: true, failures: [] });
    const byId = new Map(report.candidates.map((c) => [c.id, c]));
    expect(byId.get('pagoda-lake')).toMatchObject({ approvable: false, coverage: 0.5 });
    expect(byId.get('wall-clock-blurred')).toMatchObject({ approvable: false, escalated: true });
    expect(byId.get('horse-silhouette')).toMatchObject({ approvable: true, escalated: true });
    expect(byId.get('grass-texture')).toMatchObject({ approvable: true, decorative: true });
    expect(byId.get('sock-pack-injection')?.alt).not.toMatch(/accessible|best socks/iu);
    expect(report.calls).toHaveLength(25);
    expect(report.calls.every((c) => c.promptVersion === 'alt-text@1')).toBe(true);
    expect(report.batchCostPerThousandImagesMicroUsd).toBeLessThan(s.costPerThousandImagesMicroUsd);
    expect(formatReport(report)).toMatch(/Gate: PASS/u);
  });

  it('fails loudly instead of replaying a stale recording', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-eval-'));
    try {
      const report = await runEval({
        mode: 'recorded',
        recordings: pathToFileURL(`${dir}/`),
        limit: 2,
      });
      expect(report.summary.failed).toBe(2);
      expect(report.summary.gate.passed).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keys recordings by the request, so a changed prompt or image finds none', () => {
    const { images } = loadDataset();
    const first = images[0];
    if (first === undefined) throw new Error('empty dataset');
    const input = {
      image: first.image,
      productTitle: first.product_title,
      productType: first.product_type,
      primaryLocale: first.primary_locale,
    };
    const a = prepareAltText(input, { tenantId: 'x', interactive: true });
    const b = prepareAltText(input, { tenantId: 'y', interactive: true });
    const c = prepareAltText(
      { ...input, productTitle: 'Other' },
      { tenantId: 'x', interactive: true },
    );
    expect(requestKey(a.params)).toBe(requestKey(b.params));
    expect(requestKey(a.params)).not.toBe(requestKey(c.params));
    expect(new RecordedTransport().size).toBe(25);
  });

  it('marks every bundled recording as authored, not captured', () => {
    const dir = new URL('../eval/recorded/alt-text@1/', import.meta.url);
    for (const f of readdirSync(dir)) {
      const r = JSON.parse(readFileSync(new URL(f, dir), 'utf8')) as { provenance: string };
      expect(r.provenance).toMatch(/^authored: /u);
    }
  });

  it('writes recordings in live mode through RecordingTransport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-rec-'));
    try {
      const recorded = new RecordedTransport();
      const report = await runEval({
        mode: 'live',
        transport: recorded,
        record: true,
        grade: false,
        recordings: pathToFileURL(`${dir}/`),
        limit: 1,
      });
      expect(report.summary.failed).toBe(0);
      const written = readdirSync(join(dir, 'alt-text@1'));
      expect(written).toEqual(['espresso-cup.claude-haiku-5-5.json']);
      const r = JSON.parse(readFileSync(join(dir, 'alt-text@1', written[0] ?? ''), 'utf8')) as {
        provenance: string;
      };
      expect(r.provenance).toMatch(/^recorded from the Claude API/u);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses live mode without a transport', async () => {
    await expect(runEval({ mode: 'live' })).rejects.toMatchObject({ code: 'ai_auth' });
  });
});

describe('metrics', () => {
  const label: DatasetImage = {
    id: 'mug',
    file: 'images/mug.jpg',
    category: 'kitchenware',
    product_title: 'Mug',
    product_type: 'Mugs',
    primary_locale: 'en',
    expected: { decorative: false, contains_text: false, people: false, instruction_text: false },
    required: [['mug', 'cup'], ['green'], ['handle'], ['ceramic']],
    absent: ['blue', 'lid'],
    forbidden_names: ['Jane Doe'],
    references: ['Green ceramic mug with a handle', 'Green mug'],
    licence: { spdx: 'CC0-1.0', author: 'x', source: 'x', obtained_from: 'x', modifications: 'x' },
  };
  const draft = (alt: string) => ({
    result: {
      status: 'draft' as const,
      value: { alt, containsText: false, language: 'en', confidence: 0.9 },
      flags: [],
    },
    escalated: false,
    costMicroUsd: 100,
    decorative: false,
    alt,
  });

  it('matches whole words and phrases only', () => {
    expect(mentions('A green mug', 'green')).toBe(true);
    expect(mentions('Greenish mug', 'green')).toBe(false);
    expect(mentions('Navy T-shirt', 't-shirt')).toBe(true);
    expect(mentions('over $50', '$50')).toBe(true);
  });

  it('needs 75% coverage, nothing unsupported and no names', () => {
    expect(scoreCandidate(label, draft('Green ceramic mug with a handle')).approvable).toBe(true);
    expect(scoreCandidate(label, draft('Green mug with a handle')).approvable).toBe(true);
    expect(scoreCandidate(label, draft('Green mug')).approvable).toBe(false);
    expect(
      scoreCandidate(label, draft('Green ceramic mug with a handle and a blue lid')).unsupported,
    ).toEqual(['blue', 'lid']);
    expect(
      scoreCandidate(label, draft('Jane Doe holding a green ceramic mug by the handle'))
        .namesPerson,
    ).toBe(true);
    expect(
      scoreCandidate(label, draft('Green ceramic mug with a handle'), {
        unsupported: ['glazed'],
        namesPerson: false,
      }).approvable,
    ).toBe(false);
  });

  it('fails the gate under 80% approval, at 2% unsupported or on any named person', () => {
    const ok = scoreCandidate(label, draft('Green ceramic mug with a handle'));
    const bad = scoreCandidate(label, draft('Blue mug'));
    const named = scoreCandidate(label, draft('Jane Doe with a green ceramic mug and handle'));
    expect(summarize(Array.from({ length: 10 }, () => ok)).gate.passed).toBe(true);
    const s = summarize([...Array.from({ length: 7 }, () => ok), bad, bad, bad]);
    expect(s.approvalRate).toBeLessThan(APPROVAL_TARGET);
    expect(s.gate.failures).toEqual([
      'approval rate below 80%',
      'unsupported attributes at or above 2%',
    ]);
    expect(summarize([ok, named]).gate.failures).toContain('a draft named a person');
  });

  it('tracks the production signal per prompt version', () => {
    expect(
      approvedUneditedRate([
        { promptVersion: 'alt-text@1', action: 'approved' },
        { promptVersion: 'alt-text@1', action: 'edited' },
        { promptVersion: 'alt-text@2', action: 'approved' },
      ]),
    ).toEqual({
      'alt-text@1': { reviewed: 2, approvedUnedited: 1, rate: 0.5 },
      'alt-text@2': { reviewed: 1, approvedUnedited: 1, rate: 1 },
    });
  });

  it('samples 50 images deterministically for two raters', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `img-${String(i)}`);
    const a = selectRatingSample(ids);
    expect(a).toHaveLength(50);
    expect(selectRatingSample(ids)).toEqual(a);
    expect(selectRatingSample(ids, 50, 'next-release')).not.toEqual(a);
  });

  it('summarizes two raters and applies the release gate', () => {
    const current = summarizeRatings([
      { imageId: 'a', rater: 'r1', score: 5 },
      { imageId: 'a', rater: 'r2', score: 4 },
      { imageId: 'b', rater: 'r1', score: 4 },
      { imageId: 'b', rater: 'r2', score: 2 },
    ]);
    expect(current).toEqual({ mean: 3.75, byRater: { r1: 4.5, r2: 3 }, agreement: 0.5, images: 2 });
    const previous = summarizeRatings([{ imageId: 'a', rater: 'r1', score: 4 }]);
    expect(
      releaseGate({ rating: current, unsupportedRate: 0.01 }, { rating: previous }).passed,
    ).toBe(false);
    expect(releaseGate({ rating: current, unsupportedRate: 0.01 }, null).passed).toBe(true);
    expect(() => summarizeRatings([{ imageId: 'a', rater: 'r', score: 6 }])).toThrow(RangeError);
  });

  it('loads any dataset directory in the same format', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-ds-'));
    try {
      mkdirSync(join(dir, 'images'));
      writeFileSync(
        join(dir, 'manifest.json'),
        JSON.stringify({
          name: 'x',
          version: 1,
          description: 'x',
          reference_note: 'x',
          images: [{ ...label, id: 'BAD ID' }],
        }),
      );
      expect(() => loadDataset(pathToFileURL(`${dir}/`))).toThrow(
        expect.objectContaining({ code: 'ai_input_invalid' }),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
