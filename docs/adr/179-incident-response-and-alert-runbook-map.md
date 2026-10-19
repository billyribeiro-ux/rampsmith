# ADR-179: Incident response, the alert-to-runbook map, and the signals this build still lacks

- Status: Accepted
- Date: 2026-10-19
- Stream: WS-8 (`docs/runbooks/incident-response-and-postmortem.md`, `docs/runbooks/README.md`)
- Refines: PLAN §18 ("An incident runbook with severity levels, a 24-hour merchant notification
  target for confirmed incidents, and a blameless postmortem template"), §19, §21, §22; LAUNCH.md B7

## Context

PLAN §18 asks for an incident runbook with severity levels, a 24-hour merchant notification target for
confirmed incidents and a postmortem template; PLAN §21 lists twelve alerts (six that page, six that
open a ticket) and seven SLOs; PLAN §22 lists nine runbooks. This ADR ties them together and records
which alert has a signal behind it today. Checked in the repository on 19 Oct 2026:

- **Telemetry.** Every service exports OpenTelemetry through the collector (ADR-184 on
  `ws/deploy`), which forwards to Grafana Cloud and archives logs in R2 under `<environment>/logs/`
  for 30 days. No alert rule or dashboard definition exists in the repository (no file under `infra/`
  defines one); PLAN §21 puts alerting in Grafana Cloud, which is the founder's account (C row 9).
- **Queue signals.** The exported instruments are `rampsmith.queue.attempts` (queue and outcome
  `succeeded`, `retryable`, `permanent`, `lease_lost`) and `rampsmith.queue.claim.duration`
  (`crates/queue/src/worker.rs`). Outcome `permanent` is a permanent failure; a job that exhausts
  retryable failures is counted as `retryable` and still becomes `dead`, so no metric says "a job
  died". The worker writes the warning `job is dead` with the queue. Depth and the age of the oldest
  ready job exist as `queue::depth` and are not exported. The webhook and signature counters
  (PLAN §21: "Webhook signature failures above baseline") belong to the unbuilt intake.
- **Backup signals** (this stream): the nightly job's run conclusion, `meta.json` timestamps in R2,
  and the weekly live drill, which refuses a newest backup older than 48 hours. Nothing watches for
  a nightly job that stops running at all (a disabled schedule, GitHub dropping runs; ADR-174).
- **Shopify** notifies deprecations and imminent breaking changes through Dev Dashboard alerts and
  the app's emergency developer contact ([versioning](https://shopify.dev/docs/api/usage/versioning));
  LAUNCH.md C row 13 has the founder enter that contact. Shopify's public status page is
  <https://shopifystatus.com>; Railway's is <https://status.railway.com>; Anthropic's is
  <https://status.claude.com>.
- **Merchant email.** `@rampsmith/email` (`ws/email`, ADR-191 to ADR-193) renders an `incident_notice`
  kind in the transactional category, which is never blocked by a missing postal address, and checks
  operator-written text with the claims rules. The SES adapter, the `email.send` job and any way to
  address all merchants are **not built**.
- **Access.** PLAN §18: production database access is break-glass with a second person notified;
  cross-tenant access is through `rsctl`, audited. `rsctl` has no cross-tenant command beyond
  `doctor` and `keys`. PLAN §25 lists solo-founder capacity as a risk, so who the "second person" is has no
  answer in the repository.
- **Legal.** PLAN does not state a legal notification deadline for a personal-data incident. Whether
  one applies, to whom, and in what words is for the attorney review (LAUNCH.md C row 13); any
  notice text in the runbook is marked "attorney review required".

## Decision

1. **Four severity levels, one clock each.** The runbook defines them and the first reaction time of
   an awake responder; the figures are initial values and a change needs an ADR:

   | Level | Meaning | First response | Merchant notice (confirmed incidents) |
   | --- | --- | --- | --- |
   | SEV1 | Data of one tenant exposed to another or to a third party; a leaked key or token; a patch that breaks merchants' themes; the app unusable for everyone | 15 minutes | Within 24 hours of confirmation (PLAN §18) |
   | SEV2 | A paging alert not resolved in an hour; a core flow (install, scan, approve, fix) failing for many shops; the PITR archive or all backups failing | 1 hour | Within 24 hours if merchants were affected |
   | SEV3 | A ticket-level alert; one shop or one rule affected; degraded but working | Same working day | Only if merchants ask or were affected |
   | SEV4 | Cosmetic, or a near miss with no effect | Next working day | No |

   Paging alerts start at SEV2; the responder raises to SEV1 on the first sign of exposure.
2. **One page lists every alert, SLO and the runbook that answers it** (`docs/runbooks/README.md`),
   with a column saying whether the signal exists today. The honest state: of the twelve PLAN §21
   alerts, none has a rule in the repository; for "dead job in `shopify.*`, `github.*` or token-refresh
   queues" a log-based rule on `job is dead` can be written now; for the others the signal is not
   built (queue age and depth export, the AI breaker state, the webhook counters, the synthetic
   journey) or is the platform's (WAL archiving health from `railway postgres pitr status`, database
   connections, API 5xx from the router's metrics).
3. **Evidence first, then containment.** The runbook's security branch tells the responder to
   capture before changing: the service logs (`railway logs --service S --environment E --since 24h`
   to a private file; the R2 archive keeps 30 days), the deployment list (`railway deployment list`),
   the relevant `audit_log` rows (break-glass, through `docs/runbooks/sql/audit-window.sql`, which prints
   counts by action and tenant, the operator actions and never the `data` column; tested in
   `infra/restore-drill/tests/runbook-sql.sh`), and the ticket timeline; then contain with commands
   that are in the Railway CLI reference or the repository: stop a service
   (`railway down --service S --environment E --yes`), roll back (`deploy.yml` by hand, ADR-185),
   rotate a key (the two rotation runbooks), delete a GitHub App key, restore (the two restore
   runbooks). Nothing is deleted during an incident.
4. **Break-glass without a second person is written down, not skipped.** Until the founder names a
   second person (an Integration note and a LAUNCH.md decision), the responder records every
   superuser session in the incident ticket at the time it starts and ends (who, why, which
   statements), and that record is what the second person would have been told.
5. **Merchant notice** has a fixed shape: what happened, when, which data, what Rampsmith did, what
   the merchant should do, how to reach support. The runbook carries a template marked "attorney
   review required" and a checklist for the banned claims (no "compliant", "lawsuit-proof",
   "guaranteed", "certified"). Today the notice goes out by hand from the founder's mail account
   to addresses read in a break-glass session; the `incident_notice` email kind replaces that once
   the sender and a recipient query exist (Integration note).
6. **Postmortems are blameless, short and filed.** Within five working days of a SEV1 or SEV2
   closing, a postmortem is written from the template in the runbook and committed as
   `docs/postmortems/YYYY-MM-DD-<slug>.md` (the directory is created with the first one): timeline in UTC,
   impact in counts (never merchant names or personal data), what detected it, what slowed the
   response, what went well, and actions each with an owner and a date. Actions that change a runbook
   change it in the same pull request.
7. **Add two backup alerts to PLAN §21** (Plan correction) and one proposal for the dead-job rule.
   The thresholds are initial: a ticket when the newest complete logical backup of an environment is
   older than 36 hours or the weekly restore drill fails; a page at 72 hours. They need a monitor
   that does not depend on the workflow running (the failure it must catch is the workflow not
   running); which one is the founder's decision, because it is a new vendor or a Grafana Cloud
   synthetic check against a status object (Integration note).
8. **Runbooks are maintained by use.** Each runbook states what was verified and when. They are read
   through at each quarterly restore drill and after any incident that used them; a command that
   did not work is corrected in the incident's pull request.

## Consequences

- The alert table shows, truthfully, that launch needs work outside this stream: Grafana alert rules,
  the queue-age gauge, the AI breaker metric, the webhook intake and its counters. Each is listed
  as an integration note with the owner who can build it.
- A solo responder follows the same runbook as a team would; the record in the ticket is the
  substitute for the second person.
- The postmortem directory is created later, with the first postmortem, so no empty placeholder
  ships.

## Rejected alternatives

- Declaring the twelve alerts "in place" because PLAN §21 lists them: none has a rule or a full
  signal, and a runbook that implies otherwise misleads the person at 3 a.m.
- A stopwatch-only 24-hour target with no definition of "confirmed": the runbook defines it as the
  moment the responder can state which data and which tenants were affected, and writes the time down.
- Sending incident notices from a marketing tool: PLAN §19 treats merchants' data as the processor
  does; the notice is transactional and must not carry promotion.
- Silencing an alert during an incident to stop the phone ringing: a muted alert is a gap; the runbook
  says to acknowledge, not mute.

## Plan correction

PLAN §21, "Alerts", add to the left column ("Pages immediately"):

> The newest complete logical backup of an environment is older than 72 hours (ADR-179)

and to the right column ("Opens a ticket"):

> The newest complete logical backup of an environment is older than 36 hours · The weekly restore
> drill failed (ADR-179)

PLAN §21, "Alerts", the first left-hand row: "Any dead job in `shopify.*`, `github.*` or token-refresh
queues" is detected today from the worker's `job is dead` log line, because no metric counts dead
jobs (ADR-179); the export of `queue::depth` and of dead-job counts is work for the queue owner.
