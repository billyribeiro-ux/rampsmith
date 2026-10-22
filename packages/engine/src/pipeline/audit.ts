/**
 * The data audit of one stored batch (PLAN §11, "Data audit"; ADR-111, ADR-112): alt text of
 * product media, rich text of descriptions, pages and articles, and menu labels, through the
 * custom rules of `@rampsmith/a11y-rules`. Pure: no browser, no token, no database.
 */
import {
  auditMediaAlt,
  auditMenu,
  auditRichText,
  type DataFinding,
  type RuleId,
} from '@rampsmith/a11y-rules';
import { createHash } from 'node:crypto';
import { scrubExcerpt } from '../scrub.ts';
import type { AuditedKind, Batch } from './snapshot.ts';

/** One data finding with the facts the store needs to keep it. */
export interface DataItem {
  readonly finding: DataFinding;
  /** The offending text, scrubbed and cut to 512 characters. */
  readonly excerpt: string;
  /** Stable across scans and across edits elsewhere in the field. */
  readonly fingerprint: Uint8Array;
  /** The resource the finding sits under, such as the product that owns an image. */
  readonly owner: string;
  /** True for a product's media or text: a purchase path (PLAN §11 score). */
  readonly purchasePath: boolean;
}

export interface AuditResult {
  readonly items: readonly DataItem[];
  /** Fields or media checked. */
  readonly checksRun: number;
  /** Of those, the ones with no finding. */
  readonly checksPassed: number;
  /** Rich-text fields that could not be parsed, so were not audited. */
  readonly notAudited: number;
  /** Rules that did not run, such as the vague-link rule in an unsupported language. */
  readonly skippedRules: readonly RuleId[];
}

/** The fingerprint of a data finding: the rule, the field and what is wrong, not where. */
function fingerprintOf(finding: DataFinding, snippet: string, ordinal: number): Uint8Array {
  const { resource, field } = finding.location;
  return new Uint8Array(
    createHash('sha256')
      .update(['data', finding.ruleId, resource, field, snippet, String(ordinal)].join('\u0000'))
      .digest(),
  );
}

interface Source {
  readonly value: string;
  readonly owner: string;
  readonly purchasePath: boolean;
}

function toItems(
  findings: readonly DataFinding[],
  source: Source,
  seen: Map<string, number>,
): DataItem[] {
  return findings.map((finding) => {
    const { start, end } = finding.location;
    const snippet = source.value.slice(start, end).slice(0, 4096);
    // Identical offending snippets in one field are told apart by their order.
    const key = `${finding.ruleId}\u0000${finding.location.resource}\u0000${finding.location.field}\u0000${snippet}`;
    const ordinal = seen.get(key) ?? 0;
    seen.set(key, ordinal + 1);
    return {
      finding,
      excerpt: scrubExcerpt(snippet),
      fingerprint: fingerprintOf(finding, snippet, ordinal),
      owner: source.owner,
      purchasePath: source.purchasePath,
    };
  });
}

/** Audits the part of `batch` that `kind` names. */
export function auditBatch(kind: AuditedKind, batch: Batch, locale: string): AuditResult {
  const items: DataItem[] = [];
  const skipped = new Set<RuleId>();
  const seen = new Map<string, number>();
  let checksRun = 0;
  let checksPassed = 0;
  let notAudited = 0;

  const richText = (
    resource: string,
    field: string,
    html: string,
    owner: string,
    purchasePath: boolean,
  ): void => {
    if (html.trim() === '') return;
    checksRun += 1;
    const audit = auditRichText({ resource, field, html }, { locale });
    for (const rule of audit.skippedRules) skipped.add(rule.ruleId);
    if (audit.status === 'not_audited') {
      notAudited += 1;
      return;
    }
    if (audit.findings.length === 0) checksPassed += 1;
    items.push(...toItems(audit.findings, { value: html, owner, purchasePath }, seen));
  };

  switch (kind) {
    case 'products':
      for (const product of batch.products) {
        richText(product.id, 'descriptionHtml', product.descriptionHtml, product.id, true);
        for (const media of product.media) {
          checksRun += 1;
          const findings = auditMediaAlt({
            resource: media.id,
            alt: media.alt,
            fileName: media.fileName ?? media.url,
          });
          if (findings.length === 0) checksPassed += 1;
          items.push(
            ...toItems(
              findings,
              { value: media.alt ?? '', owner: product.id, purchasePath: true },
              seen,
            ),
          );
        }
      }
      break;
    case 'collections':
      for (const c of batch.collections) {
        richText(c.id, 'descriptionHtml', c.descriptionHtml, c.id, false);
      }
      break;
    case 'pages':
      for (const p of batch.pages) richText(p.id, 'body', p.body, p.id, false);
      break;
    case 'articles':
      for (const a of batch.articles) richText(a.id, 'body', a.body, a.id, false);
      break;
    case 'menus':
      for (const menu of batch.menus) {
        checksRun += 1;
        const findings = auditMenu({ resource: menu.id, items: menu.items });
        if (findings.length === 0) checksPassed += 1;
        // A menu item's label is not a field with offsets; the excerpt names the item.
        items.push(...toItems(findings, { value: '', owner: menu.id, purchasePath: false }, seen));
      }
      break;
  }
  return { items, checksRun, checksPassed, notAudited, skippedRules: [...skipped] };
}
