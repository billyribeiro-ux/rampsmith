# Architecture decision records

Each decision is written here, as its own file, before the code it governs (PLAN §6, §27).
When official documentation and PLAN.md disagree, the documentation wins: the difference is
recorded as an ADR and the plan is corrected in the same pull request.

| ADR | Decision | Status |
| --- | --- | --- |
| [001](001-rust-axum-control-plane.md) | Rust and Axum for the control plane | Accepted |
| [002](002-typescript-engine.md) | TypeScript for the engine | Accepted |
| [003](003-postgres-job-queue.md) | PostgreSQL is the job queue | Accepted |
| [004](004-never-write-theme-files.md) | Never write theme files; three fix channels | Accepted |
| [005](005-sveltekit-bff.md) | SvelteKit is a backend-for-frontend | Accepted |
| [006](006-shared-schema-rls.md) | Shared schema with `tenant_id`, enforced twice | Accepted |
| [007](007-span-patches.md) | Patches edit source spans only | Accepted |
| [008](008-billing-rails.md) | Shopify App Pricing; Stripe Billing for everyone else | Accepted |
| [009](009-generated-contracts.md) | Contracts are generated | Accepted |
| [010](010-railway-first.md) | Railway first, measured move of browser workers | Accepted |
| [011](011-model-routing.md) | Claude model routing by task difficulty | Accepted |
| [012](012-no-redis.md) | No Redis in R0 to R2 | Accepted |
| 013 | Reserved: evaluate Shopify Next Gen Events in R3 (PLAN §14) | Reserved |
| [014](014-sandbox-toolchain-gaps.md) | Local verification toolchain when pinned downloads are blocked | Accepted |
| [015](015-database-tests-on-provided-postgres.md) | Database tests run on a provided PostgreSQL, not testcontainers | Accepted |
| [016](016-pull-request-gate-mechanics.md) | Pull-request gate mechanics | Accepted |
| [017](017-composite-tenant-foreign-keys.md) | Composite tenant foreign keys | Accepted |
| [018](018-job-queue-protocol.md) | Job queue protocol details | Accepted |
| [019](019-telemetry.md) | Telemetry wiring | Accepted |
| [020](020-api-skeleton.md) | api skeleton, OpenAPI pipeline and images | Accepted |
| [021](021-envelope-encryption.md) | Envelope encryption of secrets at rest | Accepted |
| [022](022-shopify-authentication.md) | Shopify authentication and offline-token lifecycle | Accepted |
| [023](023-web-skeleton.md) | Web skeleton, the embedded App Home and its security headers | Accepted |
| [024](024-passkeys.md) | Passkeys and sessions for the standalone dashboard | Accepted |
| [025](025-egress-guard-and-scan-tokens.md) | The egress guard, scan tokens and the engine skeleton | Accepted |
| [026](026-design-system-primitives.md) | Design-system primitives in `packages/ui` | Accepted |
| [027](027-challenge-detection-from-s2.md) | Challenge detection calibrated by spike S-2 | Accepted |
| [028](028-service-images.md) | Images for web, engine and egress | Accepted |
| [029](029-node-26-lts-runtime.md) | Node.js 26 LTS for every Node service (26.12.0 until the LTS release) | Accepted |
| [030](030-phosphor-icons-in-the-svelte-ui.md) | Phosphor icons in the Svelte UI | Accepted |
| [031](031-shopify-credential-names-and-the-r0-live-dev-store-check.md) | Shopify credential names and the R0 live dev-store check | Accepted |
| [032](032-token-client-transport-and-error-classes.md) | Token client transport and error classes | Accepted |
| [033](033-webauthn-origin-validation.md) | WebAuthn origin validation | Accepted |
| [034](034-merge-commits-for-branches-others-build-on.md) | Merge commits for branches that other branches build on | Accepted |
| [035](035-r1-pipeline-placement.md) | Where the R1 scan-and-fix pipeline runs | Accepted |
| [036](036-r1-job-contracts.md) | Job contracts of the R1 pipeline | Accepted |
| [037](037-r1-schema.md) | The R1 schema, expand only | Accepted |
| [038](038-r1-stubs-and-lane-ownership.md) | Wired stubs, so each R1 lane edits only the files it owns | Accepted |
| [039](039-r1-dependencies-checked-on-the-registry.md) | R1 dependencies, checked on the live registry | Accepted |
| [101](101-span-patch-engine.md) | Span patch engine: offsets, overlap rule, re-parse gate and diffs | Accepted |
| [102](102-recipe-contract.md) | Recipe contract and the rules of the six markup recipes | Accepted |
| [103](103-translation-keys-in-locale-files.md) | Translation keys for recipe labels, and what each locale file receives | Accepted |
| [104](104-theme-check-in-memory.md) | Theme Check runs in memory through `@shopify/theme-check-common` | Accepted |
| [105](105-dawn-fixtures-license.md) | Dawn test fixtures and Dawn's license | Superseded by ADR-241 |
| [111](111-data-audit-parsing.md) | Parse rich text with parse5 under hard limits | Accepted |
| [112](112-custom-rule-catalog.md) | Custom rule catalog, outcomes and the data-audit rule semantics | Accepted |
| [113](113-colour-only-emphasis.md) | Definition of colour-only emphasis in rich text | Accepted |
| [114](114-browser-check-methods.md) | How the browser checks decide | Accepted |
| [115](115-browser-tests-and-chromium.md) | Browser tests on local fixtures; Playwright's Chromium in CI | Accepted |
| [116](116-interactive-states-and-guards.md) | Interactive-state scripts and their guards | Accepted |
| [121](121-github-crate-dependencies.md) | GitHub crate dependencies: aws-lc-rs and reqwest instead of jsonwebtoken and octocrab | Accepted |
| [122](122-github-app-auth-and-installation-tokens.md) | GitHub App JWTs and installation tokens | Accepted |
| [123](123-github-read-and-write-guards.md) | What Rampsmith may read and write in a theme repository | Accepted |
| [124](124-fix-pull-request-builder.md) | Fix pull-request builder: splitting, commits, body and check run | Accepted |
| [125](125-github-rest-client.md) | GitHub REST client conventions | Accepted |
| [126](126-github-webhook-intake.md) | GitHub webhook verification and parsing | Accepted |
| [127](127-github-app-manifest.md) | GitHub App manifest and its placeholders | Accepted |
| [131](131-app-pricing-plan-state.md) | Shopify App Pricing plan state through the Partner API | Accepted |
| [132](132-plan-catalog-and-entitlements.md) | Plan catalog and the single entitlements function | Accepted |
| [133](133-alt-text-draft-allowance-windows.md) | Alt-text draft allowance windows | Accepted |
| [134](134-billing-crate-dependencies.md) | Dependencies of the billing crate | Accepted |
| [141](141-app-store-theme-change-requirement.md) | Shopify App Store requirements 5.1.1 and 1.1.3 and the two code-fix channels | Accepted (decided 19 Oct 2026) |
| [142](142-vendor-facts-for-launch-documents.md) | Vendor facts read for the launch documents that refine PLAN.md and LAUNCH.md | Accepted |
| [151](151-rsctl-cli-design-and-secret-handling.md) | `rsctl` command-line design and secret handling | Accepted |
| [152](152-doctor-probes-and-vendor-documentation.md) | `rsctl doctor` probes and the vendor documentation each relies on | Accepted |
| [153](153-master-key-tools.md) | `rsctl keys`, the master-key tools | Accepted |
| [154](154-rsctl-dependencies-and-sigv4.md) | `rsctl` dependencies, and `SigV4` written by hand | Accepted |
| [155](155-live-checks-and-section-e.md) | Live checks for `rsctl doctor` and LAUNCH.md section E | Accepted |
| [156](156-rsctl-findings-and-plan-corrections.md) | Findings from building `rsctl` that change the plan, LAUNCH.md and the founder guide | Accepted |
| [161](161-theme-app-extension.md) | Theme app extension: one app embed, statement link and barrier-report form | Accepted |
| [162](162-app-proxy-barrier-report-contract.md) | App proxy contract for barrier reports (for the api) | Accepted (contract; the api implements it) |
| [163](163-embed-app-data-metafields.md) | What the app tells the embed: app-data metafields and the activation deep link | Accepted (interface; the api writes the metafields) |
| [164](164-theme-app-extension-test-harness.md) | How the theme app extension is tested: liquidjs stand-in, Chromium in the node job | Accepted |
| [171](171-nightly-logical-backup.md) | The nightly logical backup, in one streaming pass, written in bash | Accepted |
| [172](172-backup-storage-in-r2-layout-verification-retention.md) | Backup storage in R2: layout, verification, retention, lifecycle rules and locks | Accepted |
| [173](173-backup-encryption-with-age-and-key-custody.md) | Backup encryption with age, and who holds the private key | Accepted |
| [174](174-backup-workflow-environments-schedule-and-transports.md) | The backup workflow: environments, schedule, the skip gate and how the job reaches the database | Superseded by ADR-251 |
| [175](175-scripted-restore-drill.md) | The scripted restore drill: what it proves, how it can fail, what it cannot prove | Accepted |
| [176](176-restore-procedures-pitr-and-logical.md) | Restore procedures: when to use point-in-time recovery, when the logical backup, and what is not verified | Accepted |
| [177](177-key-rotation-runbooks.md) | Key rotation runbooks: the token master key, the GitHub App private key and the webhook secret | Accepted |
| [178](178-operational-runbooks.md) | Operational runbooks: dead-letter triage, webhook backlog, Shopify API version upgrade, AI provider outage | Accepted |
| [179](179-incident-response-and-alert-runbook-map.md) | Incident response, the alert-to-runbook map, and the signals this build still lacks | Accepted |
| [181](181-railway-infrastructure-as-code.md) | Railway services as infrastructure as code, in Python | Accepted |
| [182](182-service-topology-and-variables.md) | Service topology, network exposure and variables on Railway | Accepted |
| [183](183-migrations-and-database-logins.md) | Migrations in the api's pre-deploy step, as a migration role, and per-service logins | Accepted |
| [184](184-telemetry-collector-and-log-archive.md) | OpenTelemetry collector, Grafana Cloud, and a 30-day log archive in R2 | Accepted |
| [185](185-release-and-deploy-workflows.md) | Release and deploy workflows | Accepted |
| [191](191-email-legal-elements.md) | What each kind of email must carry: unsubscribe, postal address, sender | Accepted (engineering; the email category mapping needs attorney review) |
| [192](192-email-package-and-rendering.md) | `packages/email`: typed templates, message catalogs, plain text and accessible HTML | Accepted |
| [193](193-email-input-safety.md) | Email inputs: validation, escaping, links, secrets and names other people choose | Accepted |
| [194](194-email-sending-boundary.md) | The sending boundary: `EmailSender`, `guardSender`, and where `email.send` runs | Accepted |
| [201](201-synthetic-theme-corpus.md) | A synthetic theme corpus, its golden file format and its span format | Accepted |
| [202](202-static-theme-renderer.md) | Rendering corpus pages statically with liquidjs and a Shopify shim | Accepted |
| [203](203-corpus-runner-contract.md) | The corpus runner contract: mapping accuracy, fix rate and render regressions | Accepted |
| [204](204-corpus-browser-check.md) | Proving golden findings with axe-core in Chromium, inside ci.yml's node job | Accepted |
| [205](205-corpus-findings-for-integration.md) | What the corpus found about the fix catalog, the recipes and the scanner | Accepted (carried out by ADR-242 to ADR-249) |
| [211](211-ai-package-split.md) | The AI logic lives in `packages/ai`; the engine's ai worker calls it | Accepted |
| [212](212-claude-api-facts.md) | Claude API facts checked against the documentation, and the routes they set | Accepted |
| [213](213-prompts-outputs-and-untrusted-data.md) | Versioned prompts, validated outputs, and what may reach the model | Accepted |
| [214](214-ai-cost-accounting-and-budget.md) | AI cost accounting and the per-store monthly budget | Accepted |
| [215](215-ai-resilience-and-batches.md) | Retries, timeouts, the provider-outage behaviour and the batch lifecycle | Accepted |
| [216](216-rewrites-as-span-edits.md) | Description rewrites are span edits on the merchant's HTML, decided by the model | Accepted |
| [217](217-alt-text-evaluation-harness.md) | The alt-text evaluation harness, its open image set and its recorded responses | Accepted |
| [221](221-merchant-accessibility-statement.md) | The merchant accessibility statement: structure, status and wording | Accepted |
| [222](222-reports-package-rendering.md) | `packages/reports`: pure renderers, escaping by construction, inlang catalogs | Accepted |
| [223](223-isolated-pdf-printing.md) | Tagged PDFs through an isolated Chromium print | Accepted |
| [224](224-remediation-log-export.md) | Remediation log export: CSV and versioned JSON | Accepted |
| [225](225-coverage-disclosure.md) | The coverage disclosure: automated, partial and manual criteria | Accepted |
| [226](226-executive-summary-charts.md) | Executive summary: the pass rate, accessible charts and data tables | Accepted |
| [231](231-billing-uses-the-shopify-shop-domain.md) | Billing uses `shopify::ShopDomain` | Accepted |
| [241](241-no-third-party-theme-fixtures.md) | No Dawn or other third-party theme files; hand-written fixtures cover every recipe | Accepted |
| [242](242-contrast-recipe.md) | The contrast recipe: smallest OKLCH lightness change, two candidates, colour value edits | Accepted |
| [243](243-fix-targets-beyond-elements.md) | Fix targets beyond elements: colour values, CSS declarations and store data | Accepted |
| [244](244-element-mapper.md) | The element mapper and its confidence model | Accepted |
| [245](245-style-mapping.md) | Mapping style findings: the CSS cascade, colour values and the declarations behind them | Accepted |
| [246](246-rich-text-data-targets.md) | Rich text the theme prints maps to store data | Accepted |
| [247](247-corpus-runner.md) | The integrated corpus runner and its gates | Accepted |
| [248](248-fix-planner.md) | The fix planner: from a rule and a mapped span to a recipe | Accepted |
| [249](249-r2-measurement.md) | R2 measurement: the engine against the corpus, before and after | Accepted |
| [260](260-free-scanner-engine-seam.md) | The free scanner codes to an engine seam that is not connected yet | Accepted |
| [261](261-turnstile-integration.md) | Cloudflare Turnstile protects the free scanner; the script and frame are allowed on that page only | Accepted |
| [262](262-free-scanner-limits.md) | The free scanner's caps and cache live in the web process | Accepted |
| [263](263-marketing-site-structure.md) | How the marketing site is built | Accepted |
| [264](264-health-listeners-for-ctl-egress-and-engine.md) | Health listeners for ctl, egress and engine | Accepted |
| [265](265-chromium-sandbox-on-railway.md) | Chromium's sandbox on Railway | Accepted |
| [266](266-storefront-password-reaches-the-engine-sealed-per-scan.md) | A protected store's password reaches the engine sealed for one scan | Accepted |
| [267](267-free-scanner-anonymous-path.md) | The free scanner scans through the api and the engine, and the limits live in the database | Accepted |
| [268](268-r1-integration-decisions.md) | R1 integration decisions | Accepted |
| [040](040-runtime-database-roles.md) | Runtime database roles and the startup guard | Accepted |
| [041](041-per-shop-token-lock.md) | The per-shop token lock holds one connection and waits a bounded time | Accepted |
| [042](042-passkey-start-limits-and-sweep.md) | Rate limits on the passkey start endpoints, and the sweep of expired sign-in state | Accepted |
| [043](043-egress-ipv6-and-token-horizon.md) | Egress refuses IPv6 outside global unicast, scan tokens have a horizon, and spans carry no hosts | Accepted |
| [044](044-exchange-writes-are-compare-and-swap.md) | Exchange writes are compare-and-swap | Accepted |
| [045](045-master-key-rewrap-job.md) | Re-wrapping stored tokens when the master key rotates | Accepted |
| [046](046-one-session-per-sign-in.md) | A sign-in ends the user's earlier sessions, and session responses are not printable | Accepted |
| [047](047-leader-connection-and-jobs-isolation.md) | A failed leader check abandons the connection, and `jobs` joins the isolation suite | Accepted |
| [050](050-browser-network-isolation.md) | Network isolation of the scanning browser | Accepted |
| [051](051-scrub-stored-selectors-and-urls.md) | Scrubbing stored selectors and page addresses | Accepted |
| [052](052-engine-database-role-guard.md) | The engine refuses an unsafe database login | Accepted |
| [053](053-telemetry-url-redaction.md) | Spans leave the process without URLs, tokens or shop names | Accepted |
| [054](054-csp-shopify-script-directory.md) | The content security policy names Shopify's script directory, not the CDN host | Accepted |
| [055](055-dashboard-session-cookie-and-caching.md) | The dashboard session cookie carries the `__Host-` prefix, and dashboard pages are never cached | Accepted |
| [056](056-pnpm-minimum-release-age.md) | pnpm waits a day before installing a new version, and fails rather than fall back | Accepted |
| [070](070-scan-plan-and-progress.md) | Scan planning, sampling and progress | Accepted |
| [071](071-storefront-password-and-challenges.md) | Password-protected storefronts and challenges | Accepted |
| [072](072-ranking-and-fix-kind.md) | Dedupe, ranking and fix kind | Accepted |
| [073](073-verify-scan.md) | Verification scan semantics | Accepted |
| [250](250-backup-limits-are-positive-integers-and-drill-permissions.md) | Backup limits are positive integers; the restore drill starts with no token permissions | Accepted |
| [251](251-backup-is-a-railway-cron-service.md) | The nightly backup is a Railway cron service, not a GitHub workflow | Accepted |
| [252](252-one-bucket-and-one-token-per-environment.md) | One R2 bucket and one backup token per environment; the drill reads staging only | Accepted |
| [253](253-where-backup-and-drill-secrets-live.md) | Where backup and drill secrets live | Accepted |
| [254](254-rsctl-doctor-backup-checks.md) | `rsctl doctor` checks the backup inputs for shape, offline | Accepted |
| [255](255-live-drill-in-a-public-repository.md) | The live restore drill hands nothing but a summary to a public repository | Accepted |
| [256](256-signed-backup-metadata.md) | Backup metadata is signed with Ed25519; the public key is committed | Accepted |
| [257](257-restore-as-migrator-and-toc-allow-list.md) | Restore as a non-superuser and refuse archives with out-of-schema entries | Accepted |
| [258](258-backup-image-on-slim-debian.md) | The backup image is slim Debian with the PGDG client only, and CI scans it | Accepted |
| [259](259-stray-environments-and-tracked-bytecode.md) | CI fails when the old backup environments exist or Python bytecode is tracked | Accepted |
| [090](090-alt-text-job.md) | The `ai.alt_text@1` job and `sharp` | Accepted |
| [091](091-app-home-contract-and-bff.md) | The App Home contract and its backend-for-frontend routes | Accepted |
| [092](092-app-home-media-route.md) | Product images reach the App Home through the BFF | Accepted |
| [093](093-alt-text-review-queue.md) | The alt-text review queue: approve, edit, reject, undo | Accepted |
| [094](094-app-home-test-shim.md) | Testing the App Home without Shopify: a typed fake api and a Polaris shim | Accepted |
| [095](095-plan-gates-and-settings.md) | Plan gates and settings in the App Home | Accepted |
| [096](096-review-flags-and-flagged-approval.md) | Review flags reach the stored draft, and a flagged draft needs a confirmation | Accepted |
| [097](097-plan-limits-where-drafts-are-made.md) | The plan's AI budget and draft allowance are enforced where drafts are made | Accepted |
| [098](098-defer-instead-of-lose.md) | Outages and a missing key defer the job; they do not spend its attempts | Accepted |
| [099](099-image-loaders-media-limits-and-preview-load.md) | Image loaders are allow-listed; the media route is limited; the preview loads once | Accepted |
| [080](080-webhook-listener-and-admin-client.md) | The webhook listener, the compliance topics and the Admin API client | Accepted |
| [081](081-store-reads-and-scan-inputs.md) | Store reads, and what `scan_inputs` holds | Accepted |
| [082](082-data-fix-lifecycle.md) | The data-fix lifecycle: approve, apply, verify, undo | Accepted |
| [083](083-embedded-app-api-operations.md) | The embedded app's api operations | Accepted |
| [084](084-plan-state-and-partner-api-fairness.md) | Plan state in the api, and Partner API fairness (audit M3) | Accepted |
| [088](088-webhook-subscriptions-in-the-app-config.md) | Webhook subscriptions are declared in `shopify.app.toml` | Accepted |
| [089](089-redaction-privilege-group.md) | Deleting AI call records belongs to a group of its own, `rampsmith_redactor` | Accepted |
| [269](269-webhook-redaction-reaudit-fixes.md) | The re-audit's fixes to webhook handling and redaction | Accepted |

## Template

```markdown
# ADR-NNN: Title in sentence case

- Status: Proposed | Accepted | Superseded by ADR-NNN
- Date: YYYY-MM-DD

## Context
What forces the decision, with links to the evidence.

## Decision
What we do, stated so it can be checked.

## Consequences
What becomes easier, what becomes harder, what must now be true.

## Rejected alternatives
- Option: why not.
```
