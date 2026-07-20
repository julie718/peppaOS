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

# Install build tools for native modules (sqlite3, sharp, etc.)
RUN sed -i 's|http://deb.debian.org/debian|http://mirrors.aliyun.com/debian|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Fresh install on runtime glibc — avoids GLIBC mismatch from build stage
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --ignore-scripts || npm install --ignore-scripts
RUN npm rebuild

# Copy compiled code and skills
COPY --from=build /app/dist /app/dist
COPY --from=build /app/dist-server /app/dist-server
COPY --from=build /app/server/skills/bundled/ /app/skills-bundled/

RUN mkdir -p /app/data
RUN chown -R node:node /app

WORKDIR /app/dist-server

EXPOSE 3000

ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"

USER node
# ENTRYPOINT copies bundled skills on every start
ENTRYPOINT ["sh", "-c", "cp -rn /app/skills-bundled/* /app/data/skills/ 2>/dev/null; exec node entry.cjs"]
