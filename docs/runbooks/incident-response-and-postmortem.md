# Incident response and postmortem

| | |
| --- | --- |
| Answers | PLAN §18 ("an incident runbook with severity levels, a 24-hour merchant notification target for confirmed incidents, and a blameless postmortem template"); the PLAN §21 pages that no other runbook answers ("API 5xx rate above 1% for 5 minutes", "Synthetic run failed twice in a row"); the error-budget rule of PLAN §21 ("a burn rate above 2× for one hour pages"); every other runbook's SEV1 branch |
| Severity | Defines SEV1 to SEV4 (below) |
| Use it when | Any page; any sign that one tenant's data reached another tenant or a third party; a key or token may have leaked; a merchant reports harm; any other runbook says "open an incident" |
| Decisions behind it | ADR-179 (severity levels, clocks, evidence first, notice, postmortems), ADR-178 (how the runbooks fit together) |
| Verified | 2026-10-19 against the repository and the Railway CLI 5.70.0 reference. `docs/runbooks/sql/audit-window.sql` is run on every pull request (58 checks in `infra/restore-drill/tests/runbook-sql.sh`). **No incident has happened and no tabletop exercise has been run**: the first one is a Section E row. Nothing here was run against a live Railway project |

## What exists, and what does not

| Piece | State |
| --- | --- |
| This runbook, the severity table, the postmortem template, the notice template | Built (below) |
| `railway deployment list`, `railway logs --since`, `railway down`, `railway connect` | Railway CLI 5.70.0, the version `deploy.yml` pins |
| `docs/runbooks/sql/audit-window.sql` | Built and tested |
| Log archive in R2 under `<environment>/logs/` for 30 days, and the Grafana Cloud backend | Specified on `ws/deploy` (ADR-184); runs only once that branch is deployed. Grafana Cloud's free tier keeps logs 14 days (LAUNCH.md C row 9) |
| Alert rules in Grafana Cloud | **Not built.** No alert rule exists in the repository ([README](README.md) lists each alert and whether its signal exists) |
| Per-feature kill switches | **Not built.** PLAN §24 puts feature flags in PostgreSQL; no flag table exists. Stopping a service is the available switch, and it stops everything that service does |
| `rsctl` commands that read across tenants | **Not built.** `rsctl` has `doctor` and `keys` only. Cross-tenant reads are break-glass SQL |
| A second person for break-glass (PLAN §18) | **Not named.** PLAN §25 lists the founder's own capacity as a risk. Until the founder names someone, step 1 below records each session in the ticket |
| A way to email every affected merchant | **Not built.** `@rampsmith/email` renders an `incident_notice` message (`ws/email`); the SES adapter, the `email.send` job and a recipient query do not exist. Today the notice goes out by hand (step 6) |
| A public status page | **Not specified** in PLAN or LAUNCH.md. Do not promise one in a notice |
| `docs/postmortems/` | Created with the first postmortem; no empty placeholder ships |

## Severity

The first-response times are those of an awake responder; ADR-179 explains them, and a change needs an ADR. A paging alert starts at SEV2; raise it to SEV1 on the first sign of exposure.

| Level | Meaning | First response | Merchant notice (confirmed incidents) | Postmortem |
| --- | --- | --- | --- | --- |
| SEV1 | Data of one tenant exposed to another or to a third party; a leaked key or token; a patch that breaks merchants' themes; the app unusable for everyone | 15 minutes | Within 24 hours of confirmation | Yes, within 5 working days of closing |
| SEV2 | A paging alert not resolved in an hour; a core flow (install, scan, approve, fix) failing for many shops; the PITR archive or all backups failing | 1 hour | Within 24 hours if merchants were affected | Yes |
| SEV3 | A ticket-level alert; one shop or one rule affected; degraded but working | Same working day | Only if merchants ask or were affected | If something was learned |
| SEV4 | Cosmetic, or a near miss with no effect | Next working day | No | No |

**Confirmed** means the responder can state which data and which tenants were affected. Write the time of confirmation in the ticket: the 24-hour clock starts then. An incident that cannot be confirmed in a day is still escalated to the founder's decision about telling merchants what is known (step 6).

## 1. Declare it (the first 15 minutes)

1. **Open a ticket** and keep one running timeline in it, in UTC, one line per fact: time, what was seen or done, by whom. Everything below is written there as it happens, not afterwards.
2. **Acknowledge the alert; do not mute it.** A muted alert is a gap.
3. **Set the severity** from the table. If unsure between two levels, take the higher.
4. **Name the roles.** With one person, that person is commander, investigator and scribe. If anyone else is available, give them the scribe's role first: the timeline is what saves the postmortem.
5. **Break-glass sessions are written down.** Connecting to the production database as the superuser is break-glass (PLAN §18), and PLAN requires a second person to be told. Until one is named, write in the ticket when each session starts, who is connected, why, and the statements run; write when it ends. That record is what the second person would have been told. Use the read-only SQL files in `docs/runbooks/sql/` where they fit and say which one you ran.
6. **Check the providers' status before looking inward**: <https://shopifystatus.com>, <https://status.railway.com>, <https://status.claude.com>. An open incident there explains many symptoms and goes in the ticket as a link.

## 2. Capture before changing anything

Containment destroys evidence (a restarted service loses its memory, a redeploy replaces its logs' deployment). Take these first; it takes minutes, and the log archive only keeps 30 days.

```sh
umask 077
mkdir -p ./incident-<ticket> && cd ./incident-<ticket>
railway link          # once; pick the Rampsmith project
for service in web api ctl engine egress; do
  railway deployment list --service "$service" --environment production > "deployments-$service.txt"
  railway logs --service "$service" --environment production --since 24h > "logs-$service.txt"
done
```

(Adjust the service list to the services that exist. If a `railway logs` command keeps running instead of exiting after it has printed the window, stop it with Ctrl-C and check `railway logs --help` for the flags of the installed version; the exit behaviour was not verified on a live project.) Keep this directory on an encrypted disk, outside the repository. The logs are written without tokens or personal data by design (PLAN §21), but treat them as private and never paste them into a ticket: quote the lines that matter. Delete the directory when the postmortem is filed.

Also record: the commit and image digests that were deployed (`deployments-*.txt`), the time the alert fired, and the times of the first and last bad event you can find.

## 3. Find the scope

You need three answers: **which data, which tenants, which period**, and a fourth, **is it still happening?**

1. Classify the data by the PLAN §19 inventory (store content, theme snapshots, screenshots, the remediation record, dashboard users' email and passkeys, AI call metadata, billing records) and by secrets (Shopify tokens, GitHub tokens, the master key ring, the backup keys, the Anthropic key). Say which were reachable and which were read; reachable is not read.
2. The audit log for the period, in a break-glass session (write it in the ticket first):

```sh
railway connect postgres --environment production --ssh
```

```text
\set since '2026-10-19 10:00+00'
\set until '2026-10-19 14:00+00'
\i docs/runbooks/sql/audit-window.sql
```

   It prints counts by action and actor kind, the number of tenants with any audit row, and the operator actions. It prints no `data` and names tenants by id. `audit_log` is append-only. It holds only what the code chose to audit: an empty result does not show that nothing happened.
3. The logs captured in step 2 for the same period: search by the request, job or trace ids the first bad event carries.
4. Count tenants, never name them, in the ticket. Counts and ids are enough for the notice (step 6); names and addresses are read only when sending, and only by the person sending.
5. Write in the ticket the moment you can say which data and which tenants: that is **confirmation**, and the notice clock starts.

## 4. Contain

Choose the least change that stops the harm, do it, and write the time. **Nothing is deleted during an incident**: not logs, not rows, not deployments, not keys that could still be needed to read what was sealed. Rotating a key adds a key; it does not remove the old one until the key's own runbook says so.

| Situation | Containment | Then |
| --- | --- | --- |
| A bad release is serving | Run the `deploy.yml` workflow by hand from `main` with the previous commit and image digests (ADR-185 on `ws/deploy`). Migrations are never rolled back | Fix forward in a pull request |
| One service is leaking data or doing damage | `railway down --service <service> --environment production --yes` removes that service's most recent deployment. Bringing it back is a `deploy.yml` run (`railway redeploy` after `down` is not verified). Merchants see the app down for that part and Shopify retries webhooks for up to 4 hours | Step 5 before bringing it back |
| Data was damaged or deleted | [Restore from PITR](restore-from-pitr.md); if the project or the database is gone, [restore from the logical backup](restore-from-logical-backup.md) | Their own verify steps |
| The token master key ring may have leaked | [Rotate the token master key](rotate-token-master-key.md), "If a ring may have leaked" | Backups taken under the old key stay readable by whoever holds it: say so in the postmortem |
| The GitHub App private key or webhook secret may have leaked | [Rotate the GitHub App key](rotate-github-app-key.md): add the new key, deploy, delete the old key at GitHub | |
| The Anthropic key may have leaked, or AI spend is running away | Revoke the key in the Anthropic Console (the founder), then step 3 of [AI provider outage](ai-provider-outage.md) | |
| A backup age private key may have leaked | Add a new recipient (ADR-173, "Rotating a backup key"). Removing a recipient does not revoke access to files already encrypted to it | Treat every backup taken so far as readable by the holder |
| The R2 or backup credentials may have leaked | Revoke the token in the Cloudflare dashboard (the founder) and create a scoped replacement; the bucket locks (ADR-172), if the founder has applied them, keep recent backups from being deleted or overwritten | List the bucket with `infra/restore-drill/list-backups.sh` and compare it with what the last runs stored |
| The Shopify client secret may have leaked | Rotating it is a Partner Dashboard action followed by setting `SHOPIFY_API_SECRET` in Railway and deploying; check it with `rsctl doctor --row 1`. **No runbook covers this** and the steps in Shopify's dashboard were not checked: read Shopify's current documentation first | Add a runbook in the incident's pull request |
| A patch or fix is breaking merchants' themes | Stop the service that produces it (`engine`) so no more are made; undo for what was delivered follows PLAN §12 ("Verification and undo, by channel"): data fixes are written back only if the current value still equals the one Rampsmith wrote; pull requests are reverted by the merchant; a patched theme package is replaced by republishing the original theme. Rampsmith never publishes a theme. Tell affected merchants how (step 6) | A recipe-level switch is not built: add one |
| Traffic against a public endpoint | Do not loosen verification and do not answer unsigned requests differently. Cloudflare's controls for the zone are the founder's; no configuration of them exists in the repository | Note the source and the pattern |
| A person's access should end | Remove them in Railway, GitHub, Shopify Partners, Cloudflare, Anthropic and Stripe (PLAN §18 requires hardware security keys on all six); no repository file lists the members | Rotate every secret they could read |

If a containment step does not work as written here, write what you did instead in the ticket and correct this page in the incident's pull request.

## 5. Recover and verify

1. The cause is removed or contained, and the service is brought back by the route in the table above, not by hand edits.
2. Every alert that fired is back to normal on its own signal. Sweep what the incident left behind: [dead-letter triage](dead-letter-triage.md), "Acknowledge and look", for jobs that died; the [webhook backlog](webhook-backlog.md) for events that were missed.
3. Anything temporary is removed: break-glass sessions closed (end written in the ticket), temporary variables unset, local evidence directories moved to encrypted storage.
4. Anything that may have been exposed is rotated, and the rotation is verified by its own runbook.
5. Decide the severity at close (it may differ from the start) and write it down.

## 6. Tell merchants (SEV1, and SEV2 when merchants were affected)

The target is **within 24 hours of confirmation** (PLAN §18). The notice is transactional; it carries no promotion (ADR-179).

1. **The founder decides** whether, to whom and in what words; this is legal text, so it waits for the attorney review (LAUNCH.md C row 13) and is drafted from the template below, marked **attorney review required**. Whether any other party must be told (Shopify, GitHub, a regulator) and by when is the attorney's question: nothing in the repository states a deadline, so do not state one. Shopify's emergency developer contact is the one the founder enters in the Partner Dashboard (LAUNCH.md C row 13).
2. Each notice says: what happened, when, which data, what Rampsmith did, what the merchant should do, how to reach support. It says only what the ticket's confirmed facts support. A fact not yet known is written as not yet known, with a time for the next update.
3. Check the text against this list before it is sent. It must not say, or imply, that any store is compliant, certified, or protected from lawsuits, or that anything is guaranteed (PLAN §3). Do not name another company as at fault until the ticket proves it. Do not include a merchant's data or another merchant's name.
4. **Sending today**: from the founder's own mail account, one message per merchant, to addresses read in a break-glass session (written in the ticket) and never copied into the ticket or the repository. The count sent goes in the ticket. When the SES sender, the `email.send` job and the recipient query exist, the `incident_notice` message replaces this and the runbook changes in that pull request.

Template (attorney review required; replace each bracket):

```text
Subject: Security notice for your store [store handle] on Rampsmith

[ATTORNEY REVIEW REQUIRED: do not send until approved.]

On [date, UTC] at [time] we found that [what happened, in plain words].
It began on [date and time, UTC] and [ended on / was stopped on] [date and time, UTC].

What was affected: [the data, by kind: for example, "the titles of your products and the
alt-text drafts we had prepared"]. What was not affected: [only what the ticket confirms].

What we did: [containment and fixes, with dates].

What you should do: [specific steps, or "nothing is needed on your side"].
[If a key, token or session was involved: "Open the app once so it can reconnect to your store."]

We will send another update by [date and time] [or: This is our final update.]

Questions: reply to this message. [Support contact.]
```

## 7. Close and write the postmortem

1. Close the incident when step 5 is done and no alert is firing for it. Write the closing time and final severity.
2. **For SEV1 and SEV2, a postmortem within five working days.** Copy the template below to `docs/postmortems/YYYY-MM-DD-<slug>.md` (the date of the incident's start; create the directory with the first one) and open a pull request. It is blameless: it describes what the system and the process allowed, not who made a mistake. Use counts, never merchant names or personal data.
3. Every action in it has an owner and a date. An action that changes a runbook, a script or an alert changes it in the same pull request.
4. Read the runbooks that were used, line by line, while it is fresh; fix every command that did not work as written.

Postmortem template:

```markdown
# Postmortem: <short title>

- Date of incident: YYYY-MM-DD
- Severity at close: SEV<n> (at start: SEV<n>)
- Written by: <name>, on YYYY-MM-DD
- Status: draft | reviewed

## Summary
Two or three sentences: what failed, for whom, for how long.

## Impact
Counts only: tenants affected, requests failed, jobs dead, minutes of downtime, SLO burned
(PLAN §21), data exposed (kinds, not contents), merchants notified and when.

## Timeline (UTC)
| Time | Event |
| --- | --- |
| hh:mm | First bad event |
| hh:mm | Detected (by what: alert, merchant, person) |
| hh:mm | Severity set |
| hh:mm | Confirmed (which data, which tenants) |
| hh:mm | Contained |
| hh:mm | Merchants notified |
| hh:mm | Recovered / closed |

## Detection
What detected it, how long after it began, and what should have.

## Cause
The chain of conditions, not a person. Use "the system allowed" and "the process did not".

## What went well

## What slowed the response

## Actions
| Action | Owner | Due | Where tracked |
| --- | --- | --- | --- |

## Runbooks and alerts changed
Links to the pull request.
```

## Practice

At each quarterly restore drill (PLAN §24) walk through this page with a made-up SEV1 (for example "a tenant's findings appear in another tenant's report") from step 1 to the draft notice, time it, and correct what did not work. That is the Section E row for this runbook.

## Alert to runbook

| Alert or SLO | Runbook |
| --- | --- |
| Dead job in `shopify.*`, `github.*` or token-refresh queues; token refresh failures | [Dead-letter triage](dead-letter-triage.md) |
| Webhook signature failures; the webhook SLO; oldest ready job over 10 minutes | [Webhook backlog](webhook-backlog.md) |
| WAL archiving failing | [Restore from PITR](restore-from-pitr.md) |
| AI circuit breaker open; AI spend above twice average | [AI provider outage](ai-provider-outage.md) |
| API 5xx; synthetic run failed; an SLO burning | This page, then the runbook of the cause once found |
| Backup older than 36 or 72 hours; drill failed (ADR-179, proposed) | [Restore from the logical backup](restore-from-logical-backup.md) |

The full table, with whether each signal exists today, is in the [README](README.md).

## Verify (done means)

- The ticket has the timeline, the severity at start and close, the confirmation time (or "never confirmed" with why), every break-glass session, and the notice decision.
- Every alert that fired is normal; nothing is muted that was not muted before.
- Merchants who needed a notice got it within 24 hours of confirmation, or the ticket says why not and who decided.
- For SEV1 and SEV2, the postmortem pull request is open within five working days and names an owner and a date for each action.

## Rollback

Containment steps are reversible except key rotations (a rotation adds a key; the old one stays until its own runbook drops it) and a sent notice. `railway down` is undone by a `deploy.yml` run. A restore has its own rollback in its runbook. Nothing in this runbook deletes evidence.

## Escalation

The founder is the escalation for every level: decisions on spending, on telling merchants, on legal text and on Shopify, GitHub or Anthropic account actions. Provider incidents go to the providers' status and support pages above. Legal questions (what must be told to whom, and by when) go to the attorney (LAUNCH.md C row 13). When the founder cannot be reached for a SEV1 and the responder is someone else, contain first (step 4), write what was done in the ticket, and keep trying.
