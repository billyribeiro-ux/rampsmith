# The control-plane image (PLAN §22): `api` is the entrypoint; `ctl` runs from the same image
# with `--entrypoint /usr/local/bin/ctl`.
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.

# rust:1.99.1-slim-trixie
FROM rust:1.99.1-slim-trixie@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d AS build
WORKDIR /src
# The image's toolchain is the pinned one; skip rust-toolchain.toml's extra components.
ENV RUSTUP_TOOLCHAIN=1.99.1 \
    SQLX_OFFLINE=true \
    CARGO_TERM_COLOR=always
# OpenSSL headers for webauthn-rs-core (ADR-024); TLS itself stays on rustls.
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p rampsmith-api --bin api -p rampsmith-ctl --bin ctl \
    && install -m 0755 target/release/api target/release/ctl /usr/local/bin/

# sqlx-cli for Railway's pre-deploy migration step (ADR-183): the version .mise.toml pins,
# Postgres and rustls only, built from its own lockfile.
FROM rust:1.99.1-slim-trixie@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d AS sqlx
ENV RUSTUP_TOOLCHAIN=1.99.1 \
    CARGO_TERM_COLOR=always
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    cargo install sqlx-cli --version 0.9.0 --locked --no-default-features \
      --features postgres,rustls --root /opt/sqlx

# debian:trixie-slim (ADR-020: distroless once its digest can be verified)
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
# `upgrade` pulls Debian security fixes published after the pinned base was built, so a
# fixed CVE never waits for Renovate to bump the digest (the grype gate fails on those).
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends ca-certificates libssl3t64 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin rampsmith
COPY --from=build /usr/local/bin/api /usr/local/bin/ctl /usr/local/bin/
COPY --from=sqlx /opt/sqlx/bin/sqlx /usr/local/bin/sqlx
COPY crates/db/migrations /usr/local/share/rampsmith/migrations
USER 10001:10001
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
