# ADR-096: Review flags reach the stored draft, and a flagged draft needs a confirmation

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-090, ADR-093, ADR-213
- Lane: R1 lane C security audit, finding M1

## Context

`@rampsmith/ai` marks a draft with flags: `instruction_like_text_seen` when the model reports
that the image or the store data held instructions, and `suspected_prompt_injection` when the
product title or type reads like an instruction. ADR-213 says a flagged draft is excluded from
bulk approval. The alt-text job stored only the draft's text, so the flags were dropped at the
last step and nothing downstream could act on them.

## Decision

1. **The job stores the flags** in the fix's `diff` as `flags` (a sorted list of strings, empty
   when none). No migration: `diff` is the document the api already reads, and approve, edit and
   undo already preserve its keys.
2. **A first-pass flag is never lost.** When Haiku reports instruction-like text the draft is
   escalated once to Sonnet (the flag is an escalation reason, like embedded text), and the flags
   of both passes are merged into the result.
3. **The api carries them** on `AltTextChangeDto.flags`, filtered to the two known values, in the
   generated OpenAPI and TypeScript types. The App Home shows a warning banner on the card that
   says why in words, with a check ("I checked this alt text against the image and it describes
   it correctly"); Approve stays disabled until the check is ticked.
4. **Approval of a flagged fix requires `confirm_flagged=true`** on `POST .../approve`;
   without it the api answers 422 with a field error and changes nothing. A function
   (`require_confirmation`) is the one place that decides, so any path that approves fixes in
   bulk must call it per fix and never pass the flag on the merchant's behalf. No bulk approval
   exists today; if one is added it approves only unflagged fixes. The BFF forwards
   `confirm_flagged` on the approve route only.
5. An edit keeps the flags: the merchant has changed the text but the reason to look closely at
   this draft has not gone away, so the confirmation is still asked.

## Consequences

An injected product title can still produce a draft, but the merchant sees why it is suspect
and has to say so before it reaches the store. Costs one extra model call for flagged drafts
(counted against the draft allowance, ADR-097).
