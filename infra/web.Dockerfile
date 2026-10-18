# The web image (PLAN §22): SvelteKit on adapter-node, Node 26, non-root.
# Base images are pinned by digest (PLAN §27); tags are comments for humans and Renovate.

# node:26.12.0-trixie-slim
FROM node:26.12.0-trixie-slim@sha256:0d1e33586362bb9e608c4e751e7a9e7edb55c9ac11461ed5666af696cc461dd4 AS node

FROM node AS build
ENV CI=true
RUN npm install --global pnpm@12.14.0
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile --filter @rampsmith/web... \
    && pnpm --filter @rampsmith/web run build

FROM node AS deps
ENV CI=true
RUN npm install --global pnpm@12.14.0
WORKDIR /app
COPY . .
# Runtime dependencies only, in the workspace layout so Node can strip the TypeScript of the
# workspace packages the server imports (they resolve outside node_modules).
RUN pnpm install --frozen-lockfile --prod --filter @rampsmith/web...

FROM node
# Security fixes published after the base was built; npm is not needed at runtime.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
WORKDIR /app
COPY --from=deps /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages ./packages
COPY --from=deps /app/apps/web/package.json ./apps/web/package.json
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=build /app/apps/web/build ./apps/web/build
WORKDIR /app/apps/web
USER node
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000
EXPOSE 3000
CMD ["node", "build"]
