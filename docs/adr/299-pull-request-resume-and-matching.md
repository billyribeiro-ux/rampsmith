# ADR-299: Resuming a batch, and matching a pull request to its row

- Status: Accepted
- Date: 2026-10-23
- Relates to: ADR-294, integration audit findings L3 and L8

## Decision

L3. A ref update is one of `FastForward` or `Rederive { expected_head }`. A first attempt uses
`FastForward`, so a branch that already exists makes the update fail (a `github_*` code, the batch ends `failed`) and is left alone: it may be
the merchant's. A recorded pull request row means the branch is ours; the update re-derives from the
base and replaces the head only if the head still equals the pushed sha we recorded. A resumed batch
with no row but an existing branch (a crash between push and record) re-derives only while the
branch head is what the plan produced. A moved head ends the batch as `branch_moved`.

L8. Pull requests are matched by repository id and number, never by branch name or title. A webhook
for a pull request that no row names is dropped. A `push` event that touches the head or the base
branch enqueues a sync. The row is unique on tenant, repository id and number.

## Consequences

A merchant's commit on our branch is never overwritten, and a pull request edited or closed by
hand is read back, not assumed.
