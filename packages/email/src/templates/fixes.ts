/**
 * Fix notifications (PLAN §12, §16): a batch approved, then its verification result. Names of
 * the people who approved stay in the remediation log, not in email.
 */
import type { Block } from '../document.ts';
import { count, criterion, instant, label, link, list, object, oneOf, refine } from '../schema.ts';
import type { MessageKey, Translator } from '../translator.ts';
import {
  action,
  automatedChecksNote,
  bullets,
  COMMON,
  defineTemplate,
  heading,
  msg,
  paragraph,
  SUBSCRIPTION,
} from '../template.ts';
import { STORE_NAME_MAX } from './store.ts';

const CHANNELS = ['data', 'pull_request', 'theme_package'] as const;
type Channel = (typeof CHANNELS)[number];

const CHANNEL_LABELS: Readonly<Record<Channel, MessageKey>> = {
  data: 'channel_data',
  pull_request: 'channel_pull_request',
  theme_package: 'channel_theme_package',
};

const CHANNEL_NEXT: Readonly<Record<Channel, MessageKey>> = {
  data: 'fix_approved_next_data',
  pull_request: 'fix_approved_next_pull_request',
  theme_package: 'fix_approved_next_theme_package',
};

/** Fixes listed by name in one email; the rest are counted. */
const MAX_LISTED = 20;

function fixItems(
  t: Translator,
  fixes: readonly { readonly title: string; readonly criterion: string }[],
): Block {
  return bullets(
    fixes.map((fix) => msg(t, 'common_fix_item', { title: fix.title, criterion: fix.criterion })),
  );
}

export const fixApproved = defineTemplate({
  category: 'notification',
  schema: object({
    ...COMMON,
    ...SUBSCRIPTION,
    storeName: label(STORE_NAME_MAX),
    approvedAt: instant(),
    fixes: list(object({ title: label(120), criterion: criterion(), channel: oneOf(CHANNELS) }), {
      min: 1,
      max: MAX_LISTED,
    }),
    moreFixes: count(),
    fixesUrl: link(['shopifyAdmin', 'app']),
  }),
  build(input, t) {
    const store = input.storeName;
    const total = input.fixes.length + input.moreFixes;
    const channels = CHANNELS.filter((channel) => input.fixes.some((f) => f.channel === channel));
    const blocks: Block[] = [
      paragraph(
        msg(t, 'fix_approved_intro', { store, count: total, date: t.date(input.approvedAt) }),
      ),
      heading(msg(t, 'fix_approved_list_heading')),
      bullets(
        input.fixes.map((fix) =>
          msg(t, 'fix_approved_item', {
            title: fix.title,
            criterion: fix.criterion,
            channel: t.text(CHANNEL_LABELS[fix.channel]),
          }),
        ),
      ),
    ];
    if (input.moreFixes > 0) {
      blocks.push(paragraph(msg(t, 'common_more_items', { count: input.moreFixes })));
    }
    blocks.push(
      heading(msg(t, 'fix_approved_next_heading')),
      bullets(channels.map((channel) => msg(t, CHANNEL_NEXT[channel]))),
      paragraph(msg(t, 'fix_approved_log')),
      action(t, t.text('fix_approved_button'), input.fixesUrl, false),
    );
    return {
      subject: t.text('fix_approved_subject', { store, count: total }),
      preheader: t.text('fix_approved_preheader'),
      title: t.text('fix_approved_title', { count: total }),
      blocks,
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});

const fixList = () =>
  list(object({ title: label(120), criterion: criterion() }), { max: MAX_LISTED });

export const fixVerified = defineTemplate({
  category: 'notification',
  schema: refine(
    object({
      ...COMMON,
      ...SUBSCRIPTION,
      storeName: label(STORE_NAME_MAX),
      verifiedAt: instant(),
      /** Fixes whose automated checks now pass. */
      verified: fixList(),
      moreVerified: count(),
      /** Fixes whose automated checks still fail. */
      notVerified: fixList(),
      moreNotVerified: count(),
      logUrl: link(['shopifyAdmin', 'app']),
    }),
    (v) => v.verified.length + v.moreVerified + v.notVerified.length + v.moreNotVerified > 0,
    'verified',
    'and notVerified must not both be empty',
  ),
  build(input, t) {
    const store = input.storeName;
    const verifiedCount = input.verified.length + input.moreVerified;
    const failedCount = input.notVerified.length + input.moreNotVerified;
    const blocks: Block[] = [
      paragraph(msg(t, 'fix_verified_intro', { store, date: t.date(input.verifiedAt) })),
    ];
    if (verifiedCount > 0) {
      blocks.push(heading(msg(t, 'fix_verified_passed_heading', { count: verifiedCount })));
      if (input.verified.length > 0) {
        blocks.push(fixItems(t, input.verified));
      }
      if (input.moreVerified > 0) {
        blocks.push(paragraph(msg(t, 'common_more_items', { count: input.moreVerified })));
      }
    }
    if (failedCount > 0) {
      blocks.push(heading(msg(t, 'fix_verified_failed_heading', { count: failedCount })));
      if (input.notVerified.length > 0) {
        blocks.push(fixItems(t, input.notVerified));
      }
      if (input.moreNotVerified > 0) {
        blocks.push(paragraph(msg(t, 'common_more_items', { count: input.moreNotVerified })));
      }
      blocks.push(paragraph(msg(t, 'fix_verified_failed_next')));
    }
    blocks.push(
      action(t, t.text('fix_verified_button'), input.logUrl, false),
      automatedChecksNote(t),
    );
    return {
      subject:
        failedCount > 0
          ? t.text('fix_verified_subject_attention', { store })
          : t.text('fix_verified_subject', { store, count: verifiedCount }),
      preheader: t.text('fix_verified_preheader'),
      title: t.text('fix_verified_title'),
      blocks,
      reason: msg(t, 'common_reason_store', { store }),
      subscription: {
        unsubscribe: input.unsubscribeUrl,
        preferences: input.preferencesUrl,
        oneClick: input.oneClickUrl,
      },
    };
  },
});
