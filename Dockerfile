# 🌿 Hmelj webmail
#
# Multi-arch: this image is published for linux/amd64 and linux/arm64
# (.github/workflows/docker.yml builds both under QEMU).

# better-sqlite3 (message cache) is a native module — build it here where the
# compiler toolchain lives, then copy just the built node_modules into the
# slim final image below. Alpine/musl prebuilds don't always exist for every
# arch this is built for, so python3/make/g++ are here as the guaranteed
# fallback for node-gyp to compile from source.
FROM node:20-alpine AS build
RUN apk add --no-cache python3 make g++
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:20-alpine

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

# Settings, accounts, filters, the encryption key and the message cache all live
# here — mount a volume to persist them.
ENV DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME /data

USER node
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
CMD ["node", "--openssl-legacy-provider", "server/index.js"]
