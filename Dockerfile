# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────────────────────
# TAWA — all-in-one image (API + web app + embedded SQLite).
# Zero runtime npm dependencies: the image only needs Node ≥ 22.5 (node:sqlite).
#
#   build:  docker build -t tawa .
#   run:    docker run -p 8080:8080 -v tawa-data:/data tawa
#   test:   docker build --target test -t tawa-test . && docker run --rm tawa-test
# ─────────────────────────────────────────────────────────────────────────────

FROM node:22-alpine AS runtime

ENV NODE_ENV=production \
    TAWA_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    # SQLite lives here — mount a named volume to persist across restarts.
    # The file itself defaults to <TAWA_DATA_DIR>/tawa.db (see server/config.js).
    TAWA_DATA_DIR=/data

WORKDIR /app

# No build step and no node_modules: pure ESM source + static web assets.
COPY package.json ./
COPY server ./server
COPY web ./web

# node (uid 1000) owns the writable data dir and the app tree.
RUN mkdir -p /data && chown -R node:node /data /app
USER node

EXPOSE 8080

# Liveness probe — node:22 ships global fetch, so no curl/wget is needed on alpine.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# --seed is idempotent: it only provisions demo tenants when the database is
# empty, so it is safe on every start. Drop the flag to run a clean instance.
CMD ["node", "server/index.js", "--seed"]

# ── Test target: full source + automated acceptance/invariant suites (30 tests).
FROM runtime AS test
COPY tests ./tests
# Tests boot an ephemeral server + throwaway SQLite DB; nothing touches /data.
CMD ["node", "--test", "tests/"]
