# ADR-269: The re-audit's fixes to webhook handling and redaction

- Status: Accepted
- Date: 2026-10-22
- Refines: ADR-080, ADR-085, ADR-086, ADR-087
- Fixes: re-audit M-1, M-2, L-1 to L-7 (`docs/evidence/r1-webhooks-reaudit.md`)

## Decisions

1. **M-1, redaction closes the shop's other pending events.** `redact::shop` marks every
   unprocessed event of the tenant processed (bodies cleared) and cancels its `ready`
   `webhook.process` jobs, before it clears job payloads. Before, the payload clearing turned those
   jobs into dead ones, the cleared bodies made their events unreadable, and the sweep brought them
   back for 14 days while `stuck_24h` counted them for ever. The worker finishes an event whose body
   is gone on a `redacted` shop with an audit entry (`webhook.skipped_shop_redacted`); a missing
   body on a live shop is still `event_unreadable`. Migration `20261107000002` closes leftovers, and
   the sweep neither requeues nor counts an unreadable event of a redacted shop.
2. **M-2, only 401 decides.** The grant check retries every other answer (402, 403, 423,
   `SHOP_INACTIVE`, 429, 5xx, transport) whatever `AdminError::is_retryable` says, as ADR-085 item 4
   already said of 403. A 404 means the store is gone: it counts as a revoked grant for
   `shop/redact`; an `app/uninstalled` still retries on it, because the `shop/redact` that follows
   settles it. The sweep keeps requeuing `customers/*` and `shop/redact` events for 45 days instead of
   14 (PLAN §19 gives 30 days). When a person has confirmed the uninstall in the Partner Dashboard
   and the check still cannot finish, `rsctl shops redact` (shipped in the api image, run inside
   ctl's service as ctl's login) ends the installation, redacts and writes
   `compliance.shop_redacted_by_operator` with who confirmed what. It refuses any other login with
   the startup guard and does nothing without `--execute`.
3. **L-1, replay claims.** A compliance topic claims the body's SHA-256; every other topic claims
   a hash of its topic and that digest. `shop/update` and `app/uninstalled` both carry the shop
   object, and an uninstall that followed an identical `shop/update` was dropped as its replay.
4. **L-2.** The `shop/redact` transaction locks the shop row (`for update`) and reads the status
   again. A shop that was not installed when the event was read and is installed now is not
   redacted; the job retries (`shop_changed`) and checks the grant from the start.
5. **L-3, L-4, shapes.** `customers/data_request` needs `data_request` and `orders_requested`
   and refuses `orders_to_redact`; `customers/redact` needs `orders_to_redact` and refuses
   `data_request` and `orders_requested`; `shop/redact` needs `shop_id` and `shop_domain` and refuses
   `customer`, `data_request`, `orders_requested`, `orders_to_redact` and `myshopify_domain`. Unknown
   extra keys are tolerated because Shopify adds fields without a version. A refusal is logged at
   error level.
6. **L-5.** `ai_draft_holds` is in `TENANT_TABLES` and `redact::shop` deletes it.
7. **L-6.** Both listeners are served by `api::serve`, which uses hyper-util's auto builder with
   `TokioTimer` and a five second `header_read_timeout` (hyper 1.12.0 and hyper-util 0.1.21; the
   builder has no header timer without a `Timer`). `axum::serve` offers neither. A connection that
   does not finish its request head is closed.
8. **L-7, documents corrected.** ADR-085 item 4 (403 retries through the grant check, not
   `is_retryable`), ADR-086 (96 attempts take at least 1.8 days, 2.7 on average and at most 3.6: the
   delays are 5 s doubling to the one hour cap, `5115 s + 85 x 3600 s = 311 115 s` at most, between
   half and all of it with equal jitter, and the sweep window), ADR-087 (the "no plan" answer is
   cached two minutes, `NO_PLAN_CACHE`; item 9 and the consequence about ctl's login), ADR-080
   (`ai_calls` DELETE), and the "not built" rows of `dead-letter-triage.md`, `webhook-backlog.md`
   and `shopify-api-version-upgrade.md`.

## Consequences

- A shop that Shopify has frozen or closed keeps its data until Shopify answers 401 or 404, the
  sweep window ends, or an operator acts. That is the cost of never ending a live shop on an
  answer that does not say the grant is gone.
- `rsctl` is now in the api image and depends on the `db` crate.

## Rejected alternatives

- Treating 402, 403 or 423 as an uninstall: a frozen or forbidden shop may recover, and a replayed
  body would then end a live shop.
- Redacting after N days without asking Shopify: a timer cannot tell a closed store from a
  reinstalled one; a person can.
- A new job that sweeps redactions: the existing sweep already requeues by age.
