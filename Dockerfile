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
# 中国网络构建镜像：npm 包走华为云 registry（registry.npmjs.org 访问超时挂起；
# npmmirror 的 tarball 经 302 重定向到 cdn.npmmirror.com，NAS 出口间歇性单包 50-200s 黑洞，
# 曾让 npm ci 全量 1194 包挂数小时。华为云 mirrors.huaweicloud.com 实测 8MB/0.43s 最快且稳定）。
# node-gyp 编译原生模块的 Node headers 走 npmmirror（nodejs.org 连接超时）。
# lock 的 resolved 指向 registry.npmjs.org，npm 8.13+ 默认 replace-registry-host=npmjs
# 会自动改写为配置的 registry，包拉取全程走镜像。
# build_from_source=true：sqlite3 6.0.1 的 install 脚本 prebuild-install 从 github.com
# 下载 napi 预编译包（中国网络 TCP 黑洞，曾挂起 40+ 分钟），此变量让 prebuild-install
# 跳过下载直接 node-gyp 源码编译（headers 已走 npmmirror）。sharp 0.35 预编译走
# @img/sharp-* npm optionalDependencies（registry 镜像即可），无需处理。
# fetch 超时/重试收紧：npmmirror 偶发单连接 TCP 黑洞（SYN 无响应/半开），npm 默认
# fetch-timeout 300s×重试 2 次会让 npm ci 静默挂 35+ 分钟；收紧到 60s×3 次 + 降并发，
# 黑洞连接 1 分钟内失败重试，而不是无限期等待（曾实测 2259MB→1547MB 缓存零增长=下载停滞）。
ENV npm_config_registry=https://mirrors.huaweicloud.com/repository/npm/ \
    npm_config_nodejs_org_dist=https://npmmirror.com/mirrors/node/ \
    npm_config_build_from_source=true \
    npm_config_fetch_timeout=60000 \
    npm_config_fetch_retries=3 \
    npm_config_fetch_retry_mintimeout=5000 \
    npm_config_fetch_retry_maxtimeout=30000 \
    npm_config_maxsockets=8
COPY package.json package-lock.json ./
# NAS 构建加速：cdn.npmmirror.com 对 NAS 出口间歇性极慢（实测单包 50-200s），
# npm ci 全量 1194 包可挂数小时。注入预下载的 npm 缓存（docker cp <npm ci 容器>:/root/.npm → npm-cache/），
# 命中缓存秒装。缓存由诊断容器（docker run node:22-slim + 同 lock 跑 npm ci）产生，完整性校验一致。
COPY npm-cache/ /root/.npm/
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
# 与构建阶段同款中国网络镜像配置（registry + node-gyp headers + build-from-source + fetch 重试）
ENV npm_config_registry=https://mirrors.huaweicloud.com/repository/npm/ \
    npm_config_nodejs_org_dist=https://npmmirror.com/mirrors/node/ \
    npm_config_build_from_source=true \
    npm_config_fetch_timeout=60000 \
    npm_config_fetch_retries=3 \
    npm_config_fetch_retry_mintimeout=5000 \
    npm_config_fetch_retry_maxtimeout=30000 \
    npm_config_maxsockets=8
# 同款 npm 缓存注入（见 build 阶段注释），runtime 的 npm ci --ignore-scripts 同样避免全量下载
COPY npm-cache/ /root/.npm/
RUN npm ci --ignore-scripts || npm install --ignore-scripts
# node-gyp 编译 sqlite3 等原生模块需下载 Node headers；NAS 在中国网络访问 nodejs.org 超时，
# 改用 npmmirror 镜像源（sqlite3 6.0.1 无 node22 预编译产物 → 必走源码编译路径；
# build_from_source=true 同时跳过 prebuild-install 的 github.com 预编译下载黑洞）
RUN npm rebuild

# Copy compiled code and skills
COPY --from=build /app/dist /app/dist
COPY --from=build /app/dist-server /app/dist-server
# bundle 内以 process.cwd()(= /app) 相对解析的运行时资源，按仓库同款布局复制：
#   - server/skills/bundled/: 技能缺失时的自动补装兜底路径（cwd/server/skills/bundled/<name>）
#   - server/lib/: 技能编译时 import 的服务端模块（skills_extension 模板 import ../lib/logger）
#     ——缺失会导致技能 tsx 编译 TransformError、MCP 反复崩溃重启
#   - server/personality/personalities.json: 出厂人格兜底（data/ 用户演化人格优先）
#   - server/mcp/config.example.json: MCP 出厂示例兜底（运行时配置在 data/mcp_config.json）
#   - tsconfig.json: 技能 self_build 编译引用
COPY --from=build /app/server/skills/bundled/ /app/server/skills/bundled/
COPY --from=build /app/server/lib/ /app/server/lib/
COPY --from=build /app/server/personality/personalities.json /app/server/personality/personalities.json
COPY --from=build /app/server/mcp/config.example.json /app/server/mcp/config.example.json
COPY --from=build /app/tsconfig.json /app/tsconfig.json

RUN mkdir -p /app/data /app/peppa_output && \
    chown -R node:node /app/data /app/peppa_output /app/dist /app/dist-server /app/server

# WORKDIR 保持 /app（仓库根）——bundle 内全部 process.cwd() 相对路径对齐：
# data/、dist/、peppa_output/、dist-server/sandbox_child.mjs（沙箱子进程生产入口）、
# server/skills/bundled 兜底等；LUMI_DATA_DIR=/app → 数据统一落在 /app/data
EXPOSE 3000

ENV NODE_ENV=production

# 版本标识：构建时注入 git commit，/api/health 与 /api/version 据此返回 buildId，
# 用于线上核验部署版本（部署: GIT_COMMIT=$(git rev-parse --short HEAD) docker compose up -d --build）
ARG GIT_COMMIT=unknown
ENV LUMI_BUILD_ID=$GIT_COMMIT

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||3000)+'/health',r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>process.exit(r.statusCode===200?0:1))}).on('error',()=>process.exit(1))"

USER node
# ENTRYPOINT copies bundled skills on every start, then boots the compiled bundle
# （entry.cjs 内 import('./server.mjs') 按模块相对路径解析，与 cwd 无关）
ENTRYPOINT ["sh", "-c", "cp -rn /app/server/skills/bundled/* /app/data/skills/ 2>/dev/null; exec node dist-server/entry.cjs"]
