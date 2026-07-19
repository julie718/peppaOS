# PeppaOS — multi-stage Docker image
# Build:  docker build -t peppaos .
# Run:    docker run -p 3000:3000 -e JWT_SECRET=xxx peppaos

# ── Build stage ──────────────────────────────────────────────────────────
FROM node:22-slim AS build

# Use Aliyun mirror for Debian (faster in China)
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci || npm install

COPY . .
RUN npm run build:frontends && npm run build:server

# ── Runtime stage ────────────────────────────────────────────────────────
FROM node:22-slim

WORKDIR /app

# Copy with --chown to avoid slow recursive chown on node_modules
COPY --from=build --chown=node:node /app/node_modules /app/node_modules
COPY --from=build --chown=node:node /app/dist /app/dist
COPY --from=build --chown=node:node /app/dist-server /app/dist-server
COPY --from=build --chown=node:node /app/server/skills/bundled/ /app/skills-bundled/

RUN mkdir -p /app/data && chown node:node /app/data

WORKDIR /app/dist-server

EXPOSE 3000

ENV NODE_ENV=production

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"

USER node
# ENTRYPOINT copies bundled skills on every start (runs as node, needs host bind mount writable)
ENTRYPOINT ["sh", "-c", "cp -rn /app/skills-bundled/* /app/data/skills/ 2>/dev/null; exec node entry.cjs"]
