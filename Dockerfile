# Compact X-Ray web UI with a pinned Compact compiler.
#   docker build -t compact-xray .
#   docker run --rm -p 4400:4400 compact-xray            -> http://localhost:4400
# Pin COMPACT_VERSION to the toolchain your network runs (see the docs' compatibility matrix).
FROM node:22-bookworm-slim

ARG COMPACT_VERSION=0.31.1
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates xz-utils \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home xray
USER xray
WORKDIR /home/xray
RUN curl --proto '=https' --tlsv1.2 -LsSf https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh \
 && /home/xray/.local/bin/compact update "${COMPACT_VERSION}" \
 && /home/xray/.local/bin/compact compile --version
ENV PATH="/home/xray/.local/bin:${PATH}" \
    XRAY_RATE=20 \
    XRAY_COMPILE_TIMEOUT_MS=60000

WORKDIR /home/xray/app
COPY --chown=xray package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY --chown=xray src ./src
COPY --chown=xray web ./web
COPY --chown=xray examples ./examples

EXPOSE 4400
CMD ["npx", "tsx", "src/server.ts", "--host", "0.0.0.0", "--port", "4400"]
