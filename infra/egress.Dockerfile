# The egress image (PLAN §18, §22): the request-forgery guard, reachable only by `engine`.
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.

# rust:1.99.1-slim-trixie
FROM rust:1.99.1-slim-trixie@sha256:4df2ae8cfdfebdfc13a65da7f253b73d68983dc0339f2719bc17a279c913b13d AS build
WORKDIR /src
ENV RUSTUP_TOOLCHAIN=1.99.1 \
    SQLX_OFFLINE=true \
    CARGO_TERM_COLOR=always
COPY . .
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --locked -p rampsmith-egress --bin egress \
    && install -m 0755 target/release/egress /usr/local/bin/

# gcr.io/distroless/cc-debian13:nonroot, index digest read from the registry on 2026-10-17
# (spikes workflow, ADR-028): glibc, libgcc, CA certificates and nothing else.
FROM gcr.io/distroless/cc-debian13:nonroot@sha256:e792ab3d241a468a4fd7519ddbbebe66b49b5f365771716ea688ad40b6c6f1c2
COPY --from=build /usr/local/bin/egress /usr/local/bin/egress
USER 65532:65532
ENV EGRESS_BIND=0.0.0.0:8888
EXPOSE 8888
ENTRYPOINT ["/usr/local/bin/egress"]
