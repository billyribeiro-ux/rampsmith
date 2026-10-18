/**
 * Agency emails (PLAN §16): an invitation to an agency organization, the one-time store-link
 * code a store owner sends to an agency, and the notice to the owner once a link is made.
 * Agency names are chosen by other users, so they appear as quoted text, never as links.
 */
import { instant, label, link, object, oneOf, pattern } from '../schema.ts';
import type { MessageKey } from '../translator.ts';
import { action, COMMON, defineTemplate, msg, paragraph } from '../template.ts';
import { STORE_NAME_MAX } from './store.ts';

const ORGANIZATION_NAME_MAX = 100;

/** Roles an invitation can grant; Owner is never granted by invitation (PLAN §16). */
const ROLES = ['admin', 'member', 'viewer'] as const;
type Role = (typeof ROLES)[number];

const ROLE_INTROS: Readonly<Record<Role, MessageKey>> = {
  admin: 'agency_invitation_intro_admin',
  member: 'agency_invitation_intro_member',
  viewer: 'agency_invitation_intro_viewer',
};

const ROLE_DESCRIPTIONS: Readonly<Record<Role, MessageKey>> = {
  admin: 'role_admin_can',
  member: 'role_member_can',
  viewer: 'role_viewer_can',
};

export const agencyInvitation = defineTemplate({
  category: 'transactional',
  schema: object({
    ...COMMON,
    organizationName: label(ORGANIZATION_NAME_MAX),
    role: oneOf(ROLES),
    acceptUrl: link(['app']),
    expiresAt: instant(),
  }),
  build(input, t) {
    const organization = input.organizationName;
    return {
      subject: t.text('agency_invitation_subject', { organization }),
      preheader: t.text('agency_invitation_preheader'),
      title: t.text('agency_invitation_title'),
      blocks: [
        paragraph(msg(t, ROLE_INTROS[input.role], { organization })),
        paragraph(msg(t, ROLE_DESCRIPTIONS[input.role])),
        action(t, t.text('agency_invitation_button'), input.acceptUrl, true),
        paragraph(msg(t, 'agency_invitation_expiry', { date: t.dateTime(input.expiresAt) })),
        paragraph(msg(t, 'agency_invitation_not_expected')),
      ],
      reason: msg(t, 'agency_invitation_reason', { organization }),
    };
  },
});

/**
 * The one-time code that links a store to an agency. Like the sign-in token, the code is a
 * credential: it appears once in the body and nowhere else.
 */
export const storeLinkCode = defineTemplate({
  category: 'security',
  schema: object({
    ...COMMON,
    storeName: label(STORE_NAME_MAX),
    code: pattern(
      /^[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,3}$/u,
      'groups of 4 to 8 capital letters or digits joined by hyphens',
    ),
    expiresAt: instant(),
    /** The dashboard page where the agency enters the code. */
    enterCodeUrl: link(['app']),
  }),
  build(input, t) {
    const store = input.storeName;
    return {
      subject: t.text('store_link_code_subject', { store }),
      preheader: t.text('store_link_code_preheader'),
      title: t.text('store_link_code_title'),
      blocks: [
        paragraph(msg(t, 'store_link_code_intro', { store })),
        { type: 'code', label: msg(t, 'store_link_code_label'), code: input.code },
        paragraph(msg(t, 'store_link_code_steps')),
        action(t, t.text('store_link_code_button'), input.enterCodeUrl, false),
        paragraph(msg(t, 'store_link_code_expiry', { date: t.dateTime(input.expiresAt) })),
        paragraph(msg(t, 'store_link_code_scope')),
        paragraph(msg(t, 'store_link_code_not_expected')),
      ],
      reason: msg(t, 'store_link_code_reason', { store }),
    };
  },
});

/** Tells the store owner an agency now has access, with the way to remove it. */
export const storeLinked = defineTemplate({
  category: 'transactional',
  schema: object({
    ...COMMON,
    storeName: label(STORE_NAME_MAX),
    organizationName: label(ORGANIZATION_NAME_MAX),
    linkedAt: instant(),
    manageUrl: link(['shopifyAdmin', 'app']),
  }),
  build(input, t) {
    const store = input.storeName;
    const organization = input.organizationName;
    return {
      subject: t.text('store_linked_subject', { store, organization }),
      preheader: t.text('store_linked_preheader'),
      title: t.text('store_linked_title'),
      blocks: [
        paragraph(
          msg(t, 'store_linked_intro', { store, organization, date: t.date(input.linkedAt) }),
        ),
        paragraph(msg(t, 'store_linked_access', { organization })),
        paragraph(msg(t, 'store_linked_not_expected')),
        action(t, t.text('store_linked_button'), input.manageUrl, false),
      ],
      reason: msg(t, 'common_reason_store_contact', { store }),
    };
  },
});
