# The engine image (PLAN §11, §22): Playwright's Chromium for 1.64.1, run by Node 26 as a
# non-root user with Chromium's sandbox on (run with --security-opt
# seccomp=infra/engine.seccomp.json, Playwright's profile at v1.64.1).
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.

# node:26.12.0-trixie-slim
FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS node

FROM node AS deps
ENV CI=true
RUN npm install --global pnpm@12.14.0
WORKDIR /app
COPY . .
# Production dependencies of the engine and the workspace packages it imports, in the
# workspace layout: Node strips TypeScript only outside node_modules, and the workspace
# packages resolve to /app/packages through pnpm's links.
RUN pnpm install --frozen-lockfile --prod --filter @rampsmith/engine...

# mcr.microsoft.com/playwright:v1.64.1-noble, index digest read from the registry on
# 2026-10-17 (spikes workflow): Ubuntu 24.04 with Chromium 156.0.8078.4 in /ms-playwright.
FROM mcr.microsoft.com/playwright:v1.64.1-noble@sha256:7852dc5a7d72f5fe458a597d690f6c42fbc8e9e26ddfa95f8e6ef552558d9bbf
# Security fixes published after the base was built; then drop what the engine never runs:
# the base's Node 24, yarn, git and ssh, Firefox and WebKit. The browsers become read-only.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get purge -y nodejs git openssh-client \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* /usr/lib/node_modules /usr/bin/yarn /usr/bin/yarnpkg \
       /ms-playwright/firefox-* /ms-playwright/webkit-* \
    && chmod -R go-w /ms-playwright
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /app
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
USER pwuser
ENV NODE_ENV=production
ENTRYPOINT ["/usr/local/bin/node", "packages/engine/src/main.ts"]
