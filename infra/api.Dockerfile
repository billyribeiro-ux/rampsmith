# The api image (PLAN §22). `ctl` will ship in the same image with a different command.
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.

# rust:1.99.1-slim-trixie
FROM rust:1.99.1-slim-trixie@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d AS build
WORKDIR /src
# The image's toolchain is the pinned one; skip rust-toolchain.toml's extra components.
ENV RUSTUP_TOOLCHAIN=1.99.1 \
    SQLX_OFFLINE=true \
    CARGO_TERM_COLOR=always
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p rampsmith-api --bin api \
    && install -m 0755 target/release/api /usr/local/bin/api

# debian:trixie-slim (ADR-020: distroless once its digest can be verified)
FROM debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin rampsmith
COPY --from=build /usr/local/bin/api /usr/local/bin/api
USER 10001:10001
ENV BIND_ADDR=0.0.0.0:8080
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/api"]
