# ADR-191: What each kind of email must carry: unsubscribe, postal address, sender

- Status: Accepted (engineering). The category mapping is a legal reading: **attorney review
  required** before launch (LAUNCH.md C, row 13).
- Date: 2026-10-18
- Stream: WS-10 (LAUNCH.md B, onboarding and transactional email)

## Context

Rampsmith sends email to US and EU merchants, agency staff and free-scanner visitors. The
stream brief asks for unsubscribe or preference links and a postal address placeholder "where
the law requires them for each email type", checked against current official sources. These
sources were read on 17 and 18 October 2026 (quotes are short excerpts):

- **FTC, "CAN-SPAM Act: A Compliance Guide for Business"**
  (<https://www.ftc.gov/business-guidance/resources/can-spam-act-compliance-guide-business>):
  "Your message must include your valid physical postal address", which "can be your current
  street address, a post office box you've registered with the U.S. Postal Service, or a
  private mailbox you've registered with a commercial mail receiving agency"; "a clear and
  conspicuous explanation of how the recipient can opt out"; opt-outs work "for at least 30
  days after you send your message" and are honoured "within 10 business days"; the opt-out
  may not require more than "sending a reply email or visiting a single page on an Internet
  website". A transactional or relationship message "may not contain false or misleading
  routing information, but is otherwise exempt from most provisions of the CAN-SPAM Act".
- **15 U.S.C. 7702(17)(A)** (<https://uscode.house.gov/>, laws in effect 29 September 2026):
  transactional or relationship messages include those that "facilitate, complete, or confirm
  a commercial transaction", give "safety or security information", give "notification
  concerning a change in the terms or features of" or "in the recipient's standing or status
  with respect to" a subscription or account, give "at regular periodic intervals ... account
  statement[s]", or "deliver goods or services, including product updates or upgrades".
  **16 CFR 316.3** (<https://www.ecfr.gov/current/title-16/chapter-I/subchapter-C/part-316>)
  decides mixed messages by the subject line and by whether the transactional content
  appears "at the beginning of the body of the message".
- **GDPR** (Regulation 2016/679, EUR-Lex): Art. 5(1)(c) data minimisation ("limited to what is
  necessary"); Art. 7(3) withdrawing consent must be "as easy ... as to give consent"; Art.
  13(1)(a) "the identity and the contact details of the controller"; Art. 21(2) and (3), the
  right to object to direct marketing "at any time", after which the data "shall no longer be
  processed for such purposes".
- **ePrivacy Directive 2002/58/EC, Art. 13** (consolidated 19 December 2009): the soft opt-in
  requires the chance to object "free of charge and in an easy manner ... on the occasion of
  each message"; direct marketing that disguises "the identity of the sender" or has no
  "valid address to which the recipient may send a request that such communications cease"
  is prohibited.
- **UK ICO, direct marketing guidance** (updated 20 August 2025): service messages are
  "messages that aren't promotional but are for administrative or customer services purposes";
  a service message with direct-marketing elements "will count as direct marketing"; general
  branding does not. The ICO also lists asking for marketing consent as direct marketing.
  No official source (ICO or EDPB Guidelines 05/2020, para. 98) says a double opt-in
  confirmation email may not carry marketing; the decision below keeps it free of any.
- **CASL (Canada)**, CRTC FAQ (<https://crtc.gc.ca/eng/com500/faq500.htm>, modified 26 February
  2026): commercial messages identify the sender, carry a mailing address and one contact
  method, and an unsubscribe mechanism "readily performed", honoured "no later than 10
  business days" after the request; the contact information stays valid "for a minimum of 60
  days".
- **Deliverability, not law.** Google's sender guidelines
  (<https://support.google.com/mail/answer/81126>): "Marketing messages and subscribed messages
  must support one-click unsubscribe" with "a clearly visible unsubscribe link in the message
  body"; Google's FAQ (<https://support.google.com/mail/answer/14229414>) exempts transactional
  messages and recommends honouring requests "within 48 hours". Yahoo
  (<https://senders.yahooinc.com/best-practices/>): one-click unsubscribe "for marketing and
  subscribed messages", "Honor unsubscribes within 2 days". **RFC 8058**: the
  `List-Unsubscribe-Post` header "MUST contain the single key/value pair
  List-Unsubscribe=One-Click", `List-Unsubscribe` "MUST contain one HTTPS URI", the POST "MUST
  NOT include cookies, HTTP authorization, or any other context information", and the message
  needs a DKIM signature covering both headers.

## Decision

Every email kind has one category (`packages/email/src/template.ts`), and the renderer adds
what that category needs; templates cannot leave it out.

| Category | Kinds | Footer | Headers |
| --- | --- | --- | --- |
| `security` | sign-in link, email verification, free-scanner confirmation, store-link code, delivery test | Why it arrived; support contact | none |
| `transactional` | plan changed, usage limit, agency invitation, agency access added, data deletion, uninstall export, incident notice, subprocessor change | Why it arrived; support contact; sender name and postal address once set | none |
| `notification` | welcome, first scan, weekly summary, regression alert, barrier report, fix approved, fix verified | Why it arrived; email preferences; turn off this notification type; support; sender and postal address once set | `List-Unsubscribe` (HTTPS) and `List-Unsubscribe-Post: List-Unsubscribe=One-Click` |
| `marketing` | free-scanner report (it also points to how Rampsmith works) | Why it arrived; unsubscribe; support; sender and postal address (required) | as `notification` |

1. **Postal address.** CAN-SPAM and CASL require it in commercial messages only. It is a
   founder input: until `EmailSettings.postalAddress` is set, a `marketing` email renders a
   visible placeholder and reports `postal-address-missing`, which `guardSender` refuses to
   send. Other categories show the address once it is set and simply omit it before, so a
   sign-in link, an incident notice or a data-deletion confirmation is never blocked by it.
2. **Opt-out.** `notification` and `marketing` emails carry a visible unsubscribe link and the
   RFC 8058 headers. The unsubscribe endpoint (built by the app, not this package) must work
   without login or cookies, accept the one-click POST, keep working for at least 60 days
   after the email (CAN-SPAM needs 30; CASL keeps a message's contact information valid for
   60, so one window covers both), and take effect within 48 hours (Google; the
   10-business-day legal limits are looser).
3. **Sender identity.** Every footer says why the email arrived and how to reach support
   (`supportAddress`); every non-security footer names Rampsmith. The `From` header is
   `EMAIL_FROM` (LAUNCH.md C, row 7), and must name Rampsmith.
4. **Nothing promotional outside `marketing`.** Notification and transactional copy describes
   the recipient's own store, account or data; the double opt-in confirmation contains no
   promotion at all (it carries nothing the requester typed, ADR-193).
5. **No tracking** in any category: no pixels, no open or click tracking, no redirect links
   (ADR-192, ADR-194).

## Consequences

- Required notices (incident, deletion, uninstall export, security emails) can be sent before
  the founder sets the postal address; marketing cannot.
- The integrator builds two endpoints the emails link to: the one-click unsubscribe POST and
  the preferences page (ADR-194 lists them).
- Whether an agency invitation should carry a "do not email me again" link for people who never
  signed up is a founder or attorney decision; the current design treats it as a
  transactional message the recipient's acquaintance triggered, with no marketing content.

## Plan correction

- LAUNCH.md C, row 7: add the variable `EMAIL_POSTAL_ADDRESS` (Rampsmith's physical postal
  address: a street address, a USPS-registered P.O. box or a registered private mailbox; it
  must stay valid 60 days after each email) and the optional `EMAIL_TEST_RECIPIENT` (the
  founder's inbox for the live delivery test; defaults to `EMAIL_FROM`).
- LAUNCH.md C, row 13 (attorney review): add "the email category mapping in ADR-191".
- PLAN §19 "Rules": add "Notification and marketing emails carry a visible unsubscribe link and
  RFC 8058 one-click headers; the postal address appears in every non-security email and is
  required in marketing email (ADR-191)."

## Rejected alternatives

- Postal address and unsubscribe in every email: an unsubscribe link on a sign-in email is
  meaningless, and blocking security and deletion notices on a founder input would be worse
  than the risk it removes.
- Treating the free-scanner report as transactional: it promotes the product, so the stricter
  rules apply.
