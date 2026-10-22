# ADR-093: The alt-text review queue: approve, edit, reject, undo

- Status: Accepted
- Date: 2026-10-22
- Builds on: ADR-090, ADR-091
- Lane: R1 lane C (`routes/app/fixes`, `lib/app/components/FixCard.svelte`)

## Decision

1. **Nothing the model writes is applied without the merchant** (PLAN §12). The queue lists
   `proposed` fixes; Approve is the only way one is applied, and Undo (on applied and verified
   fixes) creates the revert through the api in one click.
2. **Edit is its own step.** Edit opens a labelled text area with a live character count against
   the merchant's limit and focus inside it; Escape cancels and returns focus to Edit; Save keeps
   the card in the queue, marked "Edited by you", with focus on Approve. Edited drafts count
   against the "approved unedited" measure (R1 exit criterion), so `edited` is part of the
   contract.
3. **Focus never falls to the body.** After a card leaves a list, focus moves to the next
   card's heading, else the previous one, else the list's empty message. Every action is
   announced in one polite live region (`role="status"`), not a toast, so the text is in the
   page for screen readers and for tests.
4. **Buttons name their product.** Each card's buttons carry an accessible name such as
   "Approve alt text for Blue ceramic mug", so a list of buttons is usable by name.
5. **Approved fixes are applied by a background job**, so lists poll every 2 s while any fix is
   `approved` or `applying`.
6. **Handlers are attached, not written as attributes.** Svelte's markup checks treat custom
   elements as non-interactive and warn on `onclick`. `press()`/`on()` in `lib/app/dom.ts` add
   the listener with `{@attach}`; no warning is suppressed. `<s-button>` is a real button and
   fires `click` for Enter and Space.

## Consequences

The keyboard flows are tested in `tests/app-keyboard.spec.ts`. The focus rules are the part
most likely to regress when the layout changes, which is why each has a test.
