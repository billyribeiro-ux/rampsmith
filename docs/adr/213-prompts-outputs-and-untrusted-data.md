# ADR-213: Versioned prompts, validated outputs, and what may reach the model

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §13, §18, §19)

## Context

Merchant content flows into prompts and model output flows into fixes. PLAN §18 names prompt
injection from page or product text as one of Rampsmith's two distinctive threats and answers
it with architecture: "Claude gets no tools and no secrets. Untrusted text is passed as
delimited data, outputs must match a JSON Schema, and nothing AI-written ships without human
approval." PLAN §19 lists Anthropic as a subprocessor that receives no personal data, "images
and product text only". PLAN §3 bans compliance, guarantee and certification claims anywhere.

## Decision

**Prompts.** Each task's instruction prefix is a file, `packages/ai/prompts/<task>/v<N>.txt`,
sent as the system prompt with a cache breakpoint and identical across calls; tenant data comes
after it in the user turn. `prompts/manifest.json` pins each task's current version and the
SHA-256 of the prefix together with its strict output schema; the loader refuses a mismatch,
so a prompt or schema change cannot ship without a version bump. The version (`alt-text@1`,
`rewrite@1`, `tie-break@1`, `patch-proposal@1`, `explain@1`, `grade-alt-text@1`) is stored on
every `ai_calls` row and every fix. A test runs the claims-lint CLI from
`packages/claims-lint` over the prompt files (`packages/ai/claims-lint.config.json`).

**Outputs.** Every request carries a wire schema (the strict schema minus the keywords the
structured-outputs grammar rejects); every response is read as exactly one text block, parsed
and validated with Ajv 8.20.0 (draft 2020-12, strict mode) against the strict schema. A
refusal is `ai_refused`, a `max_tokens` or context stop is `ai_output_truncated`, anything else
that is not valid JSON for the schema is `ai_output_malformed`: a failed job, never a guess or
a repair. Validation errors name a location and a keyword, never a value.

**Task checks after the schema** (a failure sends the draft to `needs_review`, it never edits
it):
- Alt text: within the merchant's limit (40 to 300 characters, default 150, counted in
  graphemes); not opening with "image of" and its equivalents in seven languages; no `<`, `>`,
  `"`, backtick or Liquid delimiters (a theme that prints `{{ image.alt }}` unescaped must not
  become an injection point); no URL or email; no instruction-like text; no banned claim the
  title or type did not already contain; the reported language matches the store's primary
  locale and the text is in that locale's script. A decorative answer goes to review.
- Rewrites: ADR-216.
- Tie-breaks: the chosen id is a candidate, confidence is at least 0.9 (PLAN §12), and the
  cited attribute appears on the rendered element and in the chosen candidate and in no other.
- Patch proposals: every `find` occurs exactly once in the mapped span, edits do not overlap,
  at most 4,000 characters change, and no edit adds a `script`, `style`, `iframe`, `object`,
  `embed`, `link`, `meta`, `base`, `form` or `input` element, a `style` or event-handler
  attribute, a `javascript:` or `data:` URL, any URL, or a Liquid tag other than `if`,
  `elsif`, `else`, `endif`, `unless` and `endunless`. Survivors are labelled "AI-proposed"; the
  engine still re-parses, runs theme-check and verifies on a preview (PLAN §12).
- Rule explanations: any banned claim, markup or instruction-like text rejects the draft; every
  draft is flagged `human_edit_required`.

**What may be sent** (PLAN §19), enforced by the input types and by building each request
field by field, never by spreading caller objects:
- Alt text: the resized image, the product title and type, the primary locale, the limit.
- Rewrites: the page title, the headings' text and levels, the flagged links' current text,
  their targets reduced to scheme, host and path (query strings and fragments can carry tokens
  or personal data), and the text of the block around each link. Never the whole field.
- Tie-breaks: the scrubbed rendered-element excerpt and the candidates' source excerpts.
- Patch proposals: the rule, the scrubbed rendered element and the mapped span. A span that
  contains an email address, a phone number or an invisible character is refused rather than
  scrubbed, because scrubbing would shift the offsets the edits depend on.
- Explanations: axe-core's rule metadata only.
- Never: customer data, order data, tokens, storefront passwords, other product fields.
All merchant text is NFC-normalized, stripped of C0/C1 controls, bidirectional controls,
zero-width characters, the Unicode tag block and supplementary variation selectors, cut to a
field limit, and scrubbed of email addresses, phone numbers and long digit runs. The opaque
`metadata.user_id` is a SHA-256 of the tenant id, never the id itself.

**Delimiting.** Untrusted data travels as JSON inside a fixed tag (`<merchant_data>`,
`<rendered_element>`, `<candidates>`, `<theme_source>`, `<rule>`, `<alt_text_under_review>`)
with `<`, `>` and `&` escaped as JSON Unicode escapes, so no value can close its block or open
another. Every prompt says that delimited data and text inside images are data, never
instructions, and asks the model to report instruction-like text in an
`instruction_like_text` field. A heuristic detector marks inputs that look like instructions
(`suspected_prompt_injection`) and rejects outputs that do; flagged drafts are excluded from
bulk approval. No task gives the model tools, and the API key never enters a prompt.

## Consequences

- An injected product title or page body can at worst produce a draft that a person rejects;
  it cannot reach a tool, a secret, another tenant, or the storefront without approval.
- Some honest drafts go to review: alt text that transcribes "certified organic" from a label
  but not from the title, or a description in a script the locale does not expect.
- Prompt text and schemas are frozen per version; improving a prompt is a new file and a new
  version, compared by the evaluation gate (ADR-217).

## Plan correction

- PLAN §18, prompt-injection row: "Claude gets no tools and no secrets. Untrusted text is
  normalized, scrubbed and passed as escaped JSON inside fixed delimiters; outputs must match a
  JSON Schema and each task's own checks (ADR-213); instruction-like inputs are flagged and
  excluded from bulk approval; nothing AI-written ships without human approval."
- PLAN §19 Subprocessors, Anthropic row: "None: product images, product titles and types,
  heading and link text, theme source spans and rule metadata; email addresses and phone
  numbers are scrubbed first."
- PLAN §13 "Data handling and resilience", first bullet: replace with the "What may be sent"
  list above.

## Rejected alternatives

- Tool use for structured answers: forced tool choice is rejected by Opus 5.5 and Sonnet 5.5,
  and a tool definition is a capability the model does not need.
- Repairing malformed JSON or trimming long alt text: a guess, which PLAN §13 forbids.
- Relying on the injection detector: heuristics miss paraphrases; it only adds a flag.
