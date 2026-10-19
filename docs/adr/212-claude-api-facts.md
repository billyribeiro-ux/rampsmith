# ADR-212: Claude API facts checked against the documentation, and the routes they set

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-12 (PLAN §13)

## Context

CLAUDE.md requires every Claude API detail to be checked in the official documentation at
implementation time, and the documentation wins over PLAN.md. The facts below were read on
17 and 18 October 2026 (`docs.claude.com` redirects to `platform.claude.com/docs`). They are
encoded in `packages/ai/src/models.ts`, `cost.ts`, `routing.ts`, `transport.ts` and
`calls.ts`, and the tests assert them.

## Facts

**Models** ([overview](https://platform.claude.com/docs/en/models/overview),
[ids and versions](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions),
[deprecations](https://platform.claude.com/docs/en/about-claude/model-deprecations)):

| Model id | Context / max output | Default effort | Thinking | Retires not sooner than |
| --- | --- | --- | --- | --- |
| `claude-haiku-5-5` | 1M / 128K | `medium` | adaptive, on by default; `disabled` allowed at effort `high` or below | 7 Oct 2027 |
| `claude-sonnet-5-5` | 1M / 128K | `high` | adaptive; `between_tools` (no up-front thinking) at `high` or below; `disabled` is a 400 | 28 Sep 2027 |
| `claude-opus-5-5` | 1M / 128K | `medium` | always on; `disabled` is a 400 | 22 Sep 2027 |

For the 4.6 generation and later a dateless id is a pinned snapshot, not an alias. At least 60
days' notice precedes a retirement. All three accept images, structured outputs and the Batch
API. Prefill is rejected (400), and Opus 5.5 and Sonnet 5.5 reject forced tool use; Rampsmith
uses neither. Thinking counts toward `max_tokens` and is billed as output
([effort](https://platform.claude.com/docs/en/build-with-claude/effort),
[errors](https://platform.claude.com/docs/en/api/errors)).

**Prices per million tokens** ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)):

| Model | Input | Output | 5-min cache write | 1-hour cache write | Cache read |
| --- | --- | --- | --- | --- | --- |
| Haiku 5.5, prompts up to 100,000 tokens | $0.10 | $0.50 | $0.125 | $0.20 | $0.01 |
| Haiku 5.5, prompts over 100,000 tokens | $0.50 | $2.50 | $0.625 | $1.00 | $0.05 |
| Sonnet 5.5 | $2 | $10 | $2.50 | $4 | $0.10 |
| Opus 5.5 | $4 | $20 | $5 | $8 | $0.20 |

The Batch API halves every category, and caching multipliers stack with it. A Haiku request's
prompt length counts cache reads and writes, and the whole request takes the higher tier when
it crosses 100,000 tokens. Cache reads are 0.1× input on Haiku and 0.05× on Sonnet and Opus
5.5. `inference_geo: "us"` costs 1.1×; Rampsmith uses the default global routing.

**Vision** ([vision](https://platform.claude.com/docs/en/build-with-claude/vision)): an image
costs ⌈width ÷ 28⌉ × ⌈height ÷ 28⌉ visual tokens. Claude 4.7 and later (all three models) are
on the high-resolution tier: images above 2576 px on the long edge or 4784 tokens are
downscaled. JPEG, PNG, GIF and WebP; 10 MB per image in base64 on the API (5 MB on Bedrock and
Google Cloud); 8000 × 8000 px at most; requests of more than 20 images get a stricter
per-image limit; 32 MB per Messages request. Claude does not name people in images. "Image
uploads are ephemeral and not stored beyond the duration of the API request", and "Anthropic
does not use uploaded images to train models" (vision FAQ).

**Structured outputs**
([structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)):
generally available, sent as `output_config.format = { type: "json_schema", schema }` with no
beta header (`output_format` is deprecated). Supported: the basic types, `enum`, `const`,
`anyOf`, `allOf`, `$ref`/`$defs`, `required`, `additionalProperties: false` (mandatory),
`minItems` of 0 or 1, some string formats and simple `pattern`s. Not supported: `minLength`,
`maxLength`, `minimum`, `maximum`, `multipleOf`, other array constraints, recursion. Output can
still miss the schema on `stop_reason: "refusal"` (billed) or `"max_tokens"`. Changing the
schema invalidates the prompt cache for that thread; compiled grammars are cached 24 hours.
Works with the Batch API; incompatible with citations and prefill.

**Prompt caching** ([prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)):
512-token minimum on all three models (shorter prompts are processed without caching and no
error); `cache_control: { type: "ephemeral", ttl: "5m" | "1h" }`, at most 4 breakpoints; the
prefix order is tools, system, messages; adding or removing images changes only the messages
level. Caches are isolated per organization and per workspace. Batch cache hits are best
effort; the docs advise the 1-hour TTL for batches.

**Limits and errors** ([rate limits](https://platform.claude.com/docs/en/api/rate-limits),
[errors](https://platform.claude.com/docs/en/api/errors)): Start tier 1,000 RPM, 2M input and
400K output tokens per minute per model; only uncached input counts toward ITPM. Monthly spend
caps are $500 (Start), $1,000 (Build) and $200,000 (Scale). A spend-cap 429 carries
`error.details.error_code = "enforced_spend_limit_reached"` and no `retry-after`; a spend limit
the organization sets returns 400 with "You have reached your specified API usage limits".
429 with `retry-after`, 500, 504 and 529 (`overloaded_error`) are transient. The SDK retries
twice by default and validates that non-streaming requests stay under 10 minutes.

**Batches** ([batch processing](https://platform.claude.com/docs/en/build-with-claude/batch-processing)):
100,000 requests or 256 MB per batch; `custom_id` matches `^[a-zA-Z0-9_-]{1,64}$`; results
within 24 hours or the request expires; results come back in any order as `succeeded`,
`errored`, `canceled` or `expired` (the last three unbilled); request and response data are
stored up to 29 days unless the batch is deleted with `DELETE /v1/messages/batches/{id}`.
Start tier: 200,000 requests in the processing queue.

**Data retention** ([API and data retention](https://platform.claude.com/docs/en/manage-claude/api-and-data-retention),
[privacy center](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data),
[commercial terms](https://www.anthropic.com/legal/commercial-terms)): API inputs and outputs
are deleted from Anthropic's backend within 30 days by default; under a zero-data-retention
arrangement they are not stored after the response. The Batch API and the Files API are not
ZDR-eligible; prompt caching and structured outputs are (structured outputs cache only the
schema, up to 24 hours). Content flagged by trust and safety may be kept up to 2 years. Fable
5.1 and the other "Covered Models" require 30-day retention; Haiku, Sonnet and Opus 5.5 are not
listed as covered. The commercial terms: "Anthropic may not train models on Customer Content
from Services."

## Decision

The routes (`routing.ts`), each a thinking mode the model accepts at its effort:

| Task | Model | Mode | Effort | Thinking | `max_tokens` | Timeout |
| --- | --- | --- | --- | --- | --- | --- |
| Alt text | Haiku 5.5 | batch; sync when a merchant waits | `low` | `disabled` | 400 | 60 s |
| Alt text, escalated | Sonnet 5.5 | as above | `low` | `between_tools` | 600 | 90 s |
| Description and page rewrites | Sonnet 5.5 | sync when waiting, else batch | `medium` | `between_tools` | 4,000 | 120 s |
| Source-mapping tie-breaks | Sonnet 5.5 | sync | `low` | `between_tools` | 400 | 60 s |
| Patches for custom widgets | Opus 5.5 | batch | `high` | adaptive (always on) | 32,000 | 600 s |
| Rule explanations | Haiku 5.5 | batch | `low` | `disabled` | 1,000 | 60 s |
| Evaluation grader | Sonnet 5.5 | sync | `low` | `between_tools` | 600 | 90 s |

Turning thinking off for alt text keeps output near the plan's 60 tokens per image; the
evaluation gate decides whether a route ever needs more effort. The SDK's own retries are off
(`maxRetries: 0`) so the retry policy, breaker and ledger see every attempt (ADR-215).

## Consequences

- The cost model holds on current prices: one 1008 × 1008 image (1,296 tokens) with a
  780-token prompt and 70 output tokens costs (2,076 × $0.05 + 70 × $0.25) / 10⁶ ≈ $0.00012 on
  Haiku batch, about $0.12 per 1,000 images. The prompt size is an estimate until the live run
  measures it (the 4.7+ tokenizer yields about 30% more tokens than earlier models, and
  structured outputs add a system prompt of their own).
- Each image escalated to Sonnet 5.5 on batch costs about (2,076 × $1 + 120 × $5) / 10⁶ ≈
  $0.0027, so every 10% escalated adds about $0.27 per 1,000 images.
- The instruction prefixes are near the 512-token caching minimum; prompts under it are simply
  not cached, at a cost of fractions of a cent per thousand images.

## Plan correction

- PLAN §13 "Model routing": add the effort and thinking columns of the table above, and the
  sentence "Thinking counts toward `max_tokens` and is billed as output; alt text and rule
  explanations run with thinking disabled, Sonnet routes with `between_tools`, and Opus 5.5
  always thinks."
- PLAN §13, model availability: replace "until at least September and October 2027" with
  "Haiku 5.5 not before 7 October 2027, Sonnet 5.5 not before 28 September 2027, Opus 5.5 not
  before 22 September 2027, with at least 60 days' notice" and link the deprecations page.
- PLAN §13 "Cost model for alt text": state that Haiku 5.5's prices are tiered at 100,000
  prompt tokens and that cache reads and writes count toward the tier; keep the formula, but
  read "400 prompt tokens" as an estimate to be replaced by the live run's measurement
  (LAUNCH.md section E); replace "Escalating 10% of images to Sonnet 5.5 on batch adds roughly
  $0.20 per 1,000 images" with "about $0.27 per 1,000 images".
- PLAN §13 "Prompts and outputs": "Every response uses structured outputs (`output_config.format`,
  generally available; no beta header) against a JSON Schema restricted to the supported
  keywords; Ajv enforces the full schema, including the length and range constraints the
  grammar does not support."
- PLAN §13 "Data handling and resilience", second bullet: add "Image uploads are not stored
  beyond the request; other API inputs and outputs are deleted within 30 days; batches are
  deleted as soon as their results are stored (ADR-215)."

## Rejected alternatives

- Leaving thinking at each model's default: Haiku 5.5 thinks by default at `medium`, which
  multiplies alt-text output tokens for no measured gain.
- Pinning `claude-haiku-4-5-20251001`: its earliest retirement date, 15 October 2026, has
  passed, so it can be retired at any time with 60 days' notice, and it costs ten times as much
  per input token as Haiku 5.5.
