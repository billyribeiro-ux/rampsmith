# ADR-184: OpenTelemetry collector, Grafana Cloud, and a 30-day log archive in R2

- Status: Accepted
- Date: 2026-10-18
- Stream: WS-9 (`infra/collector/`)
- Refines: PLAN §21, ADR-019; LAUNCH.md C rows 6 and 9; STATUS.md "Log retention"

## Context

PLAN §21 keeps logs 30 days in one backend (Grafana Cloud on its free tier). The architect's
ruling ("Log retention", STATUS.md): Grafana Cloud Free keeps 14 days, Pro keeps 30 at a cost,
so keep Free and archive logs to R2 for 30 days through the collector's S3-compatible exporter,
after verifying it against R2.

Checked on 17–18 Oct 2026:

- **Collector.** `opentelemetry-collector-releases` v0.163.1 (16 Oct 2026, the newest tag) ships
  `otelcol-contrib`, whose manifest (`distributions/otelcol-contrib/manifest.yaml` at that tag)
  includes `otlpreceiver`, `memorylimiterprocessor`, `batchprocessor`, `resourceprocessor`,
  `attributesprocessor`, `otlphttpexporter`, `awss3exporter`, `basicauthextension`,
  `healthcheckextension` and the `env` config provider (all v0.163.0). The image's
  `ENTRYPOINT` is `/otelcol-contrib`, `CMD` is the default config file, and it runs as UID
  10001.
- **S3 exporter** (`exporter/awss3exporter/README.md` and `s3_writer.go` at contrib v0.163.0):
  `s3uploader` takes `region`, `endpoint`, `s3_bucket`, `s3_base_prefix`, `s3_prefix`,
  `s3_partition_format`, `s3_partition_timezone`, `s3_force_path_style`, `compression`
  (`gzip`), `unique_key_func_name: uuidv7`; `marshaler: otlp_json`; credentials follow the AWS
  SDK's default chain, loaded with `config.LoadDefaultConfig` (aws-sdk-go-v2 `config` v1.33.6,
  which reads `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
  `AWS_REQUEST_CHECKSUM_CALCULATION` / `AWS_RESPONSE_CHECKSUM_VALIDATION` =
  `when_supported|when_required`, `config/env_config.go`).
- **R2** ([S3 API](https://developers.cloudflare.com/r2/api/s3/api/)): endpoint
  `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, region `auto` (`us-east-1` and empty alias
  to it); PutObject and multipart uploads are implemented; checksums: CRC64NVME full-object
  only, CRC32, CRC32C, SHA1 and SHA256 composite only.
  [Object lifecycles](https://developers.cloudflare.com/r2/buckets/object-lifecycles): rules
  by prefix with `Expiration: { Days: N }`, set in the dashboard, with
  `wrangler r2 bucket lifecycle add`, or with `PutBucketLifecycleConfiguration`, which needs a
  "Workers R2 Storage Write" token; objects go "within 24 hours" of expiring.
- **Grafana Cloud** ([OTLP endpoint](https://grafana.com/docs/grafana-cloud/send-data/otlp/send-data-otlp.md),
  [OpenTelemetry tile](https://grafana.com/docs/grafana-cloud/observe-and-act/agent-observability/get-started/grafana-cloud/)):
  `https://otlp-gateway-<region>.grafana.net/otlp` for metrics, logs and traces over HTTP;
  Basic authentication with the "Instance ID on the OpenTelemetry card" as user name and an
  access-policy token with `metrics:write`, `logs:write` and `traces:write` as password.
- **The services today** (ADR-019): Rust and TypeScript export traces and metrics over OTLP/HTTP
  when `OTEL_EXPORTER_OTLP_ENDPOINT` is set; logs go to standard output as JSON, not over OTLP.

## Decision

1. **One collector service** on Railway runs the stock `otel/opentelemetry-collector-contrib`
   image pinned by digest (`COLLECTOR_IMAGE` in `railway.py`). Its configuration is
   `infra/collector/config.yaml`, passed in the `OTELCOL_CONFIG` variable and read with
   `--config=env:OTELCOL_CONFIG`, so no image is built for it. The file holds only `${env:...}`
   references, never a credential.
2. **In**: OTLP/HTTP on `[::]:4318`, private network only (no public domain, ADR-182). Every
   service points `OTEL_EXPORTER_OTLP_ENDPOINT` at it and carries no Grafana credential.
3. **Out to Grafana Cloud**: `otlphttp` with gzip and the `basicauth` extension
   (`GRAFANA_CLOUD_OTLP_INSTANCE_ID` and `GRAFANA_CLOUD_OTLP_TOKEN`, collector only).
4. **Archive to R2**: the logs pipeline also feeds `awss3` with `region: auto`, the account
   endpoint, path-style addressing, gzip-compressed OTLP JSON under
   `<environment>/logs/year=…/month=…/day=…/hour=…/` (UTC), and UUIDv7 object keys. The SDK's
   checksum behaviour is set to `when_required`, so no checksum type R2 rejects is ever sent;
   TLS protects the upload. Only logs are archived.
5. **Its own bucket and token**: `R2_BUCKET_LOGS`, written with `R2_LOGS_ACCESS_KEY_ID` and
   `R2_LOGS_SECRET_ACCESS_KEY` (an R2 token scoped to that bucket, Object Read & Write), so a
   compromised collector cannot touch evidence or backups and the evidence token cannot touch
   logs. The founder adds a lifecycle rule that deletes objects after 30 days (prefix empty),
   in the dashboard or with `npx wrangler r2 bucket lifecycle add`.
6. **Hygiene**: `memory_limiter` first, the environment as `deployment.environment.name`, and
   an `attributes` processor that deletes authorization, cookie and webhook-signature header
   attributes from spans and logs if a service ever records them (PLAN §21: no tokens in logs).
7. **Health**: the `health_check` extension on `[::]:13133/healthz`, Railway's health check.
8. **Verification now** (LAUNCH.md E substitute): `infra/collector/tests/smoke.py` runs the
   pinned image with the real config the way Railway starts it, against a fake Grafana gateway
   that accepts only the expected Basic credentials and a fake path-style S3 endpoint. It checks
   that `validate` accepts the config and rejects a broken one, the health check, that traces,
   metrics and logs reach "Grafana" with credentials and the environment attribute, that only
   logs reach the archive as gzip OTLP JSON under the expected prefix, and that scrubbed headers
   never leave. The live checks are listed in `docs/evidence/ws-9-deploy.md`.

## Consequences

- Grafana Cloud stays on the free tier; 30-day log retention comes from R2. Choosing Grafana Pro
  later only removes the archive exporter.
- Logs reach the archive only once services send them over OTLP. Integration work for the main
  builder: add OTLP log export next to the JSON standard-output logs (Rust:
  `opentelemetry-appender-tracing`; engine: an OTLP log exporter for its logger), keeping
  ADR-019's rules (no payloads, no personal data).
- Railway documents that a start command overrides the image's `ENTRYPOINT`, not what happens to
  its `CMD`; if Railway kept the image's `CMD`, the collector would also load its default
  config. The first staging deploy checks the collector's start-up log (live check list). The
  fallback is a two-line `infra/collector.Dockerfile` that copies the config into the image.
- R2 storage for logs is billed (founder decision already made in row 6: the R2 subscription).

## Rejected alternatives

- Grafana Pro for 30-day logs: a cost the architect left to the founder.
- Sharing the evidence bucket and token: one leaked token would reach both.
- A custom collector image: one more image to build and scan for a config file.
- Services sending straight to Grafana Cloud: every service would hold the Grafana token, and
  there would be no place to archive logs.

## Plan correction

PLAN §21, first paragraph. Replace "Every service emits OpenTelemetry traces, metrics and logs to
one backend (Grafana Cloud on its free tier at the start)" with:

> Every service emits OpenTelemetry traces, metrics and logs to a collector on the private
> network, which forwards them to Grafana Cloud (free tier, 14 days) and archives logs in R2
> for 30 days (ADR-184)

PLAN §21, "Instrumentation", Logs bullet. Replace "kept 30 days" with:

> sent over OTLP and kept 30 days in the R2 archive (14 in Grafana Cloud Free; ADR-184)

LAUNCH.md C row 9. Replace the "Variables" cell with:

> `GRAFANA_CLOUD_OTLP_ENDPOINT`, `GRAFANA_CLOUD_OTLP_INSTANCE_ID`, `GRAFANA_CLOUD_OTLP_TOKEN`
> (the endpoint, Instance ID and generated token from the stack's OpenTelemetry tile; used by
> the collector only, ADR-184)

and its "How the code proves it works" cell with:

> A trace and a log visible in Grafana Cloud, and the log in the R2 archive

LAUNCH.md C row 6. Append to "You create": "a third bucket for logs with a 30-day lifecycle
rule, and a second token scoped to it", and to "Variables": `R2_BUCKET_LOGS`,
`R2_LOGS_ACCESS_KEY_ID`, `R2_LOGS_SECRET_ACCESS_KEY` (ADR-184).

`docs/FOUNDER_SETUP.md` section 9 then copies the endpoint, the Instance ID and the token instead
of the `OTEL_EXPORTER_OTLP_*` environment-variable block.
