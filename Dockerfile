# syntax=docker/dockerfile:1
FROM node:24-alpine AS base
RUN corepack enable
# Fallback toolchain for better-sqlite3 when no musl prebuilt binary matches. The runtime stage
# starts from a clean image and gets none of this.
RUN apk add --no-cache python3 make g++
WORKDIR /app

FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN pnpm build

FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,target=/root/.local/share/pnpm/store pnpm install --frozen-lockfile --prod

FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
COPY --chown=node:node drizzle ./drizzle
COPY --chown=node:node assets ./assets
RUN mkdir -p /app/data && chown node:node /app/data
# sharp renders caption text through fontconfig, which the bare alpine image lacks.
RUN apk add --no-cache fontconfig
USER node
CMD ["node", "dist/index.js"]
