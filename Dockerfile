# 🌿 Hmelj webmail
#
# Multi-arch: this image is published for linux/amd64 and linux/arm64
# (.github/workflows/docker.yml builds both under QEMU).

# better-sqlite3 (the message cache) is the only native module, and 13.x SHIPS its
# compiled binaries inside the package — lib/linuxmusl-x64.js and
# lib/linuxmusl-arm64.js load prebuilds/linuxmusl-{x64,arm64}.node, which is
# exactly what this Alpine image needs on both published architectures. Nothing
# has to be compiled, so there is deliberately no python3/make/g++ here.
#
# --ignore-scripts is what makes that reliable rather than lucky. better-sqlite3
# ships a binding.gyp and declares no `install` script, and npm supplies an
# implicit `node-gyp rebuild` for exactly that shape — so whether the build
# compiles is decided by the npm version in the base image, not by anything in
# this repo. npm 11.16 skipped it; 11.19 ran it, and the build broke the moment
# node:24-alpine picked up the newer npm. Skipping install scripts pins the
# behaviour, and costs nothing here: the only production packages that have any
# are @firebase/util (a no-op unless FIREBASE_WEBAPP_CONFIG is set, which it
# never is) and protobufjs (a version-scheme warning that returns early).
# Verified: full `npm ci --ignore-scripts` install loads better-sqlite3 from its
# prebuild, resolves firebase-admin/app and firebase-admin/messaging, and passes
# all 21 test suites.
#
# Worth keeping in mind if this is ever revisited: on 11.x there was no Node 24
# prebuild at all, so the arm64 leg compiled SQLite under QEMU — about twenty
# minutes per build — and the Codexa project traced an intermittent native crash
# to that same source-build-against-a-newer-ABI combination.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:24-alpine

LABEL org.opencontainers.image.title="Hmelj" \
      org.opencontainers.image.description="Self-hosted, Gmail-style webmail client for IMAP/SMTP, Microsoft 365 and Exchange" \
      org.opencontainers.image.source="https://github.com/thehijacker/hmelj" \
      org.opencontainers.image.url="https://thehijacker.github.io/hmelj/" \
      org.opencontainers.image.licenses="AGPL-3.0-only"

ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./

COPY server ./server
COPY public ./public
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# su-exec drops root to the app user in the entrypoint. Alpine's busybox `su`
# does not exec cleanly (it forks, so signals and the exit code stop working
# properly), which is exactly what an init process must not do.
RUN apk add --no-cache su-exec && chmod +x /usr/local/bin/docker-entrypoint.sh

# Settings, accounts, filters, the encryption key and the message cache all live
# here — mount a volume to persist them.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

# Deliberately NOT `USER node`: the entrypoint starts as root purely to take
# ownership of a bind-mounted /data, then drops to PUID:PGID (1000:1000 by
# default) with su-exec before the app is exec'd. No application code runs as
# root. Starting the container with an explicit --user skips all of that and is
# still supported.
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT:-3000}/healthz || exit 1

# --openssl-legacy-provider: httpntlm's NTLM implementation (used by the
# Exchange/EWS account type) unconditionally computes a DES-ECB-based LM
# hash as part of every auth handshake, even when the extended-security
# NTLMv2 path immediately discards it in favor of an HMAC-MD5 response
# instead — DES-ECB is real, historic NTLM protocol behavior, just no
# longer exposed by OpenSSL 3's default provider (Node 17+). Without this
# flag, that unconditional (and, in practice, unused) computation throws
# and crashes the whole process on every EWS auth attempt. Only affects
# which legacy algorithms are *available*, not what the rest of the app
# actually uses elsewhere (e.g. accounts.js's AES-256-GCM stays as coded).
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "--openssl-legacy-provider", "server/index.js"]
