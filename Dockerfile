# syntax=docker/dockerfile:1

# Pikado is a client-side app: the image is a build of static files and a web
# server to hand them out. Nothing runs server-side, so there is no runtime
# Node process and no reason to ship one — the final image carries nginx and a
# few hundred kilobytes of bundle, not a toolchain.

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
# Vite 8 requires Node ^20.19 || >=22.12; 22 is the current LTS line.
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies are copied and installed on their own so this layer is reused
# for every build that does not change package-lock.json — which is most of
# them. Copying the source first would reinstall on every edit.
COPY package.json package-lock.json ./

# `npm ci` rather than `npm install`: it installs exactly the locked tree and
# fails if the lockfile and manifest disagree, which is what a reproducible
# build needs. Vite is the only dependency, so this is quick.
RUN npm ci

COPY . .

RUN npm run build

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------
FROM nginx:1.27-alpine AS runtime

# See docker/nginx.conf — the cache headers there are load-bearing, because
# this app ships a service worker that caches hashed assets indefinitely.
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=build /app/dist /usr/share/nginx/html

# Metadata for anyone who pulls the image without the repository.
LABEL org.opencontainers.image.title="Pikado" \
      org.opencontainers.image.description="Free, open-source Photoshop alternative that runs in your browser. Fully client-side apart from an optional, bring-your-own-key Generative Fill." \
      org.opencontainers.image.source="https://github.com/koneb71/pikado" \
      org.opencontainers.image.licenses="MIT"

EXPOSE 80

# 127.0.0.1, not localhost: wget prefers the IPv6 answer, so "localhost" here
# means [::1] and the check fails against anything bound to IPv4 only. That is
# a container that serves every request correctly while reporting itself
# unhealthy — and an orchestrator in front of it then refuses to route, which
# surfaces as 502 rather than as anything mentioning health.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O - http://127.0.0.1/ >/dev/null 2>&1 || exit 1

# The base image's own entrypoint handles config templating and signals.
