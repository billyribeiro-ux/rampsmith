# ADR-265: Chromium's sandbox on Railway

- Status: Accepted (supersedes the open question in ADR-028's Consequences)
- Date: 2026-10-22
- Stream: R1 release gaps (`packages/engine`, `infra/railway/tests`)
- Refines: ADR-028, ADR-050; PLAN §18, §22; threat model E1

## Context

ADR-028 left one question for the first deploy: whether Railway runs containers with a seccomp
profile that lets Chromium's own sandbox start, and, if not, "the platform's own isolation with
the sandbox off, decided then with evidence". The strict release smoke test now forces the
question: started as Railway starts it (no custom seccomp profile; on a GitHub runner Docker's
default profile), the engine exits
([run 39873911672](https://github.com/billyribeiro-ux/rampsmith/actions/runs/39873911672), job
`verify engine`).

Evidence, with its limits:

- Playwright 1.64.1's [Docker guide](https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/docs/src/docker.md):
  the image runs as root by default, "which will disable the Chromium sandbox which is not
  available with root"; for untrusted sites use a separate user "in combination with the
  seccomp profile"; the profile "is needed to run Chromium with sandbox" and is Docker's
  default plus "extra user namespace cloning permissions". Its
  [`chromiumSandbox` option](https://raw.githubusercontent.com/microsoft/playwright/v1.64.1/docs/src/api/params.md)
  "Defaults to `false`": Playwright itself passes `--no-sandbox` unless asked not to, and the
  engine explicitly asks (`launchOptions`).
- Railway documents no container security setting: no seccomp, AppArmor or capability option
  (ADR-050 read the same pages for network policy; ADR-185 evidence item 5). Its documentation
  does not say whether unprivileged user namespaces work.
- Third-party reports from Railway deployments (the Railway Station threads that turn up for
  "Chromium sandbox Railway" could not be opened from this environment; their titles include
  "Chromium sandbox fails with credentials.cc:137 Permission denied in Railway runtime" and
  "Intermittent Chromium user-namespace sandbox failure on Railway V2"):
  [mposition/Tomverse#2862](https://github.com/mposition/Tomverse/pull/2862) records six
  Playwright 1.63 and 1.64 runs on Railway where the sandbox "start[ed] on some hosts and
  fail[ed] on others" with `FATAL ... Check failed: . : Permission denied (13)` even though
  `unprivileged_userns_clone=1` and `NoNewPrivs=0`;
  [fairenow/gsw-mail#97](https://github.com/fairenow/gsw-mail/pull/97) records
  `credentials.cc:137, Permission denied 13` in a non-root Railway container (9 Oct 2026) and
  falls back to `--no-sandbox`. These are not Railway statements, but two independent projects
  and the platform's silence agree: the answer depends on the host, not on our image.

So neither fixed choice is safe. Always requiring the sandbox risks an engine that cannot start
on some Railway hosts; always disabling it gives up a layer on hosts that allow it.

## Decision

1. **The engine tries Chromium's sandbox first and starts without it only when the host refuses
   it.** `launchEngineBrowser` (`packages/engine/src/browser.ts`) launches with
   `chromiumSandbox: true`. Only if the launch error matches Chromium's sandbox-setup
   signatures (`No usable sandbox`, `credentials.cc`, `Failed to move to new namespace`,
   `User namespace not supported`, `SUID sandbox helper`, `namespace_sandbox`) does it launch a
   second time with `chromiumSandbox: false`. A timeout, a crash, a missing library or a missing
   binary is thrown, never retried without the sandbox. Both launches carry the same
   WebRTC policy and the `<-loopback>` proxy rule (ADR-050).
2. **It says which mode it is in.** `main.ts` writes `engine: chromium sandbox=on|off` to stderr
   and, when off, `engine: warning: this host refused Chromium's sandbox (<Chromium's line>)`.
   The image smoke test asserts both lines (`image_smoke.sh`, engine branch), so the test
   passes only if the chosen mode starts and is stated.
3. **`ENGINE_CHROMIUM_SANDBOX=required`** turns the fallback off for a host where the sandbox is
   known to work; any other value than `auto` or `required` stops the engine, so a typo never
   loosens it. The default is `auto`. The Railway spec does not set it: the first staging deploy
   shows which mode Railway's host gives (LAUNCH.md E, "Chromium's sandbox on Railway's hosts"), and the founder can pin
   `required` in Railway variables afterwards if it is `on`.
4. The Docker-side path is unchanged: `infra/smoke/engine.sh` still runs `self-check.ts`
   (`launchBrowser`, sandbox required) under `infra/engine.seccomp.json`, so "sandbox on works
   in the image" stays tested; the release smoke test proves "Railway-style start works".

## Trade-off, stated plainly

Without the sandbox a renderer exploit is code execution as `pwuser` in the engine container,
one step instead of two (renderer exploit plus sandbox escape). That process can read the
engine's environment: its database role (ADR-052), the egress token secret, the Claude API key
and the evidence-upload credentials. What still holds, all of it in the code today:

- non-root (`pwuser`), `/ms-playwright` read-only, no shell tools beyond the base image's;
- every request, WebRTC included, goes to egress (ADR-050), whose address policy and scan token
  checks are unchanged, so the compromised browser cannot reach loopback, the private network
  or cloud metadata through the proxy;
- a fresh browser context per page, closed after the scan, with service workers blocked and
  downloads refused, and hard time limits;
- the engine opens no listener except the health route (ADR-264).

What does not: Railway offers no outbound filter (ADR-050), so a direct connection from a
compromised browser process is not blocked at the network level, as ADR-050 already recorded for
the sandbox-on case. The recommendation in ADR-050 therefore carries more weight: when the AI and
upload queues move to a second service from the same image, the scanning service should hold no
Claude or storage credentials. Until then, `auto` on a host that refuses the sandbox is an
accepted residual risk for launch, recorded in LAUNCH.md E and the threat model (E1).

## Consequences

- The engine starts on Railway whichever way the host answers, and the answer is in the deploy
  log from the first start.
- A test (`packages/engine/test/browser.test.ts`) pins the rules: sandbox first, fallback only
  on a refusal signature, never under `required`, never for another failure, a failed second
  launch is thrown.
- The signature list is Chromium's wording and can drift with a Chromium update; the failure
  mode is safe (an unrecognised refusal fails the launch loudly, it does not start unsandboxed).

## Amendment (audit H1, ADR-280): the fallback never serves the free scanner

The trade-off above was accepted for merchants' own stores. The free scanner (ADR-267) loads sites
chosen by anyone, so an engine whose Chromium runs without the sandbox does **not** register the
`free_scan.run` queue, and the api refuses free scans (503, "free scanner unavailable") while no
sandboxed engine is serving them. The residual risk recorded here therefore no longer includes
anonymous pages. The recommendation to give the scanning service no Claude or storage credentials
is now stronger still and is restated, for the free scanner, in ADR-280: a separate low-privilege
service from the same image (not built; it costs money).

## Plan correction

PLAN §18 (threat table, row "A hostile page exploits the browser") and §22 (`engine` row):
"Chromium's sandbox is on wherever the host allows it; Railway hosts that refuse unprivileged
user namespaces get it off, logged (ADR-265)". Threat model E1: same, status "planned; engine
logs the mode at start".

## Rejected alternatives

- Always `--no-sandbox` (what the reports above do): gives up a layer on every host that
  allows it, and Playwright's own guidance for untrusted sites is the opposite.
- Always require the sandbox: the engine would not start on hosts that refuse it, and Railway
  gives no setting to change that.
- A fallback on any launch error: hides timeouts and missing libraries behind a weaker mode.
- Granting `SYS_ADMIN` or a custom seccomp profile: not available on Railway (above).
