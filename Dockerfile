# MayOS — single-container Docker image
# Build:  docker build -t mayos .
# Run:    docker run -p 3000:3000 -e JWT_SECRET=xxx mayos

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

# Only runtime deps
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist
COPY --from=build /app/dist-server /app/dist-server

# bundled技能打进镜像 — 启动时自动拷到持久化目录
COPY --from=build /app/server/skills/bundled/ /app/skills-bundled/

# data/ is a volume — created at runtime by the app if not mounted
RUN mkdir -p /app/data

WORKDIR /app/dist-server

EXPOSE 3000

ENV NODE_ENV=production

# Health check pings the Express health endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"

RUN chown -R node:node /app
USER node
CMD ["sh", "-c", "cp -rn /app/skills-bundled/* /app/data/skills/ 2>/dev/null; exec node entry.cjs"]
