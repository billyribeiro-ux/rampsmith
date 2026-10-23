# ADR-314: Linking a store: the agency makes a code, the merchant approves it in App Home

- Status: Accepted
- Date: 2026-10-23
- Stream: R2 (agency view)
- Security-sensitive: yes

## Decision

1. **The agency starts.** A signed-in dashboard user who is a member of an organization asks for a
   link code. The code is ten symbols of Crockford base32 without `I`, `L`, `O`, `U` (50 bits, from
   the operating system's generator), shown once as `XXXXX-XXXXX`. Only its SHA-256 is stored. It
   works once and for one day. An organization holds at most ten unused codes.
2. **The merchant decides.** In App Home, "Agency access", the merchant types the code; the app shows
   the organization's name and what a link gives; approving creates the link. A typed code is read
   forgivingly (case, dash, space, `O` as `0`, `I` or `L` as `1`) and nothing else.
3. **Guessing is throttled per shop**: five codes that are not valid in an hour, counted from the
   audit log, and the shop is refused (429) even for a valid code until they age out. Preview and
   approve share the count. A code that is unknown, used, expired or malformed all answer the same 404.
4. **What the agency sees**: store domain, pass rate, open issues and how many are serious or
   critical, the latest regression counts, the latest scan's time and status, the date linked.
   Nothing else. The App Home screen says so before approval.
5. The `agency_invitation`, `store_link_code` and `store_linked` email templates exist
   (`packages/email`), but no sender path to an address that is not a store owner exists (the mailer
   addresses a shop owner by reference, ADR-272), so none is sent in this change. The code is shown to
   the agency user, who passes it to the merchant. A `store_linked` notice to the owner is a follow-up
   that needs a recipient kind for organization members.

## Consequences

LAUNCH.md section E gets a dev-store row for the full flow.
