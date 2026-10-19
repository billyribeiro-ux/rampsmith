/**
 * Data and security notices (PLAN §18, §19): data-deletion confirmation, the export link sent
 * on uninstall, incident notices and subprocessor changes. None can be switched off.
 */
import { scanText } from '@rampsmith/claims-lint/src/scan.ts';
import type { Block } from '../document.ts';
import { skeleton } from '../sanitize.ts';
import {
  bool,
  instant,
  InputError,
  label,
  link,
  list,
  object,
  oneOf,
  optional,
  prose,
  refine,
  type Schema,
} from '../schema.ts';
import type { MessageKey } from '../translator.ts';
import { action, bullets, COMMON, defineTemplate, heading, msg, paragraph } from '../template.ts';
import { STORE_NAME_MAX } from './store.ts';

export const dataDeletion = defineTemplate({
  category: 'transactional',
  schema: refine(
    object({
      ...COMMON,
      /** `store`: a store's data after `shop/redact`; `account`: a dashboard user's account. */
      scope: oneOf(['store', 'account'] as const),
      /** Required when `scope` is `store`. */
      storeName: optional(label(STORE_NAME_MAX)),
      completedAt: instant(),
      /** Whether billing records were kept because tax law requires them. */
      billingRecordsKept: bool(),
    }),
    (v) => (v.scope === 'store') === (v.storeName !== undefined),
    'storeName',
    'is required for scope "store" and not allowed for scope "account"',
  ),
  build(input, t) {
    const date = t.date(input.completedAt);
    const store = input.storeName;
    const blocks: Block[] =
      store === undefined
        ? [
            paragraph(msg(t, 'data_deletion_account_intro', { date })),
            paragraph(msg(t, 'data_deletion_account_last')),
          ]
        : [
            paragraph(msg(t, 'data_deletion_store_intro', { store, date })),
            paragraph(msg(t, 'data_deletion_store_last', { store })),
          ];
    if (input.billingRecordsKept) {
      blocks.splice(1, 0, paragraph(msg(t, 'data_deletion_billing_kept')));
    }
    return {
      subject:
        store === undefined
          ? t.text('data_deletion_account_subject')
          : t.text('data_deletion_store_subject', { store }),
      preheader: t.text('data_deletion_preheader', { date }),
      title: t.text('data_deletion_title'),
      blocks,
      reason:
        store === undefined
          ? msg(t, 'data_deletion_account_reason')
          : msg(t, 'common_reason_store_contact', { store }),
    };
  },
});

/** On uninstall: a link to export the remediation record before the data goes (PLAN §19). */
export const uninstallExport = defineTemplate({
  category: 'transactional',
  schema: object({
    ...COMMON,
    storeName: label(STORE_NAME_MAX),
    exportUrl: link(['app']),
    /** When the data is deleted and the link stops working. */
    deleteAt: instant(),
  }),
  build(input, t) {
    const store = input.storeName;
    const date = t.date(input.deleteAt);
    return {
      subject: t.text('uninstall_subject', { store }),
      preheader: t.text('uninstall_preheader', { date }),
      title: t.text('uninstall_title'),
      blocks: [
        paragraph(msg(t, 'uninstall_intro', { store, date })),
        paragraph(msg(t, 'uninstall_export')),
        action(t, t.text('uninstall_button'), input.exportUrl, true),
        paragraph(msg(t, 'uninstall_expiry')),
      ],
      reason: msg(t, 'common_reason_store_contact', { store }),
    };
  },
});

/**
 * Operator-written text, held to the same claims policy as the catalogs (PLAN §3): a banned
 * claim in it fails the render instead of reaching a merchant.
 */
function operatorText(max: number): Schema<string, string> {
  const inner = prose(max);
  return {
    optional: false,
    parse(value, path, ctx) {
      const text = inner.parse(value, path, ctx);
      // An allow marker is for the repository's own files; in an email it would both switch
      // the check off and appear in the message.
      if (/claims-lint-allow/iu.test(text)) {
        throw new InputError(path, 'must not contain a claims-lint allow marker');
      }
      // Letters from two scripts in one word ("cоmpliant" with a Cyrillic o) only disguise.
      for (const word of text.match(/[\p{L}\p{M}]+/gu) ?? []) {
        if (/\p{Script=Latin}/u.test(word) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(word)) {
          throw new InputError(path, 'must not mix Latin with Cyrillic or Greek letters in a word');
        }
      }
      // Scan one line in skeleton form: a word hyphenated across a line break is rejoined, and
      // look-alike letters, hidden characters and other dashes cannot split a banned phrase.
      const flat = skeleton(text.replace(/\p{Pd}\n/gu, '')).replace(/\s+/gu, ' ');
      const found = scanText(path, flat).violations[0];
      if (found !== undefined) {
        throw new InputError(path, `contains a banned claim (${found.rule}): ${found.message}`);
      }
      return text;
    },
  };
}

/** A confirmed security incident affecting the recipient (PLAN §18, 24-hour target). */
export const incidentNotice = defineTemplate({
  category: 'transactional',
  schema: object({
    ...COMMON,
    /** The affected store, when the notice is about one store. */
    storeName: optional(label(STORE_NAME_MAX)),
    confirmedAt: instant(),
    whatHappened: operatorText(2000),
    dataInvolved: operatorText(2000),
    whatWeAreDoing: operatorText(2000),
    whatYouCanDo: optional(operatorText(2000)),
    /** A status page with updates, on the site origin. */
    updatesUrl: optional(link(['site'])),
  }),
  build(input, t, env) {
    const date = t.date(input.confirmedAt);
    const store = input.storeName;
    const blocks: Block[] = [
      paragraph(
        store === undefined
          ? msg(t, 'incident_intro_account', { date })
          : msg(t, 'incident_intro_store', { date, store }),
      ),
      heading(msg(t, 'incident_what_happened')),
      { type: 'prose', text: input.whatHappened },
      heading(msg(t, 'incident_data_involved')),
      { type: 'prose', text: input.dataInvolved },
      heading(msg(t, 'incident_what_we_do')),
      { type: 'prose', text: input.whatWeAreDoing },
    ];
    if (input.whatYouCanDo !== undefined) {
      blocks.push(heading(msg(t, 'incident_what_you_can_do')), {
        type: 'prose',
        text: input.whatYouCanDo,
      });
    }
    blocks.push(paragraph(msg(t, 'incident_contact', { support: env.support })));
    if (input.updatesUrl !== undefined) {
      blocks.push(action(t, t.text('incident_button'), input.updatesUrl, false));
    }
    return {
      subject:
        store === undefined
          ? t.text('incident_subject_account')
          : t.text('incident_subject_store', { store }),
      preheader: t.text('incident_preheader'),
      title: t.text('incident_title'),
      blocks,
      reason:
        store === undefined
          ? msg(t, 'incident_reason_account')
          : msg(t, 'common_reason_store_contact', { store }),
    };
  },
});

const CHANGES = ['added', 'removed', 'changed'] as const;
type Change = (typeof CHANGES)[number];

const CHANGE_ITEMS: Readonly<Record<Change, MessageKey>> = {
  added: 'subprocessor_item_added',
  removed: 'subprocessor_item_removed',
  changed: 'subprocessor_item_changed',
};

/** Subprocessor changes, announced at least 30 days ahead (PLAN §19). */
export const subprocessorChange = defineTemplate({
  category: 'transactional',
  schema: object({
    ...COMMON,
    effectiveAt: instant(),
    changes: list(
      object({
        change: oneOf(CHANGES),
        name: label(100),
        purpose: label(200),
        location: label(100),
      }),
      { min: 1, max: 10 },
    ),
    /** The last day to object. */
    objectBy: instant(),
    listUrl: link(['site']),
  }),
  build(input, t, env) {
    const date = t.date(input.effectiveAt);
    return {
      subject: t.text('subprocessor_subject', { date }),
      preheader: t.text('subprocessor_preheader'),
      title: t.text('subprocessor_title'),
      blocks: [
        paragraph(msg(t, 'subprocessor_intro', { date })),
        bullets(
          input.changes.map((c) =>
            msg(t, CHANGE_ITEMS[c.change], {
              name: c.name,
              purpose: c.purpose,
              location: c.location,
            }),
          ),
        ),
        paragraph(
          msg(t, 'subprocessor_objection', {
            date: t.date(input.objectBy),
            support: env.support,
          }),
        ),
        action(t, t.text('subprocessor_button'), input.listUrl, false),
      ],
      reason: msg(t, 'subprocessor_reason'),
    };
  },
});
