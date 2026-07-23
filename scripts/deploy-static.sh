#!/bin/bash
# PeppaOS 前端静态文件部署 — 构建 + 直传 NAS 静态目录
# 执行后无需重启任何容器，iPhone App 杀掉重开即生效

set -e
NAS_HOST="${NAS_HOST:-qweasd.top}"
NAS_PORT="${NAS_PORT:-4041}"
NAS_USER="${NAS_USER:-ray}"
NAS_STATIC="${NAS_STATIC:-/home/ray/mayos/static}"

echo "=== 1. 构建 mobile ==="
cd "$(dirname "$0")/.."
npm run build:mobile

echo "=== 2. 部署到 NAS ==="
cd dist/mobile
tar czf - . | ssh -p "$NAS_PORT" "$NAS_USER@$NAS_HOST" "tar xzf - -C $NAS_STATIC/ && cp $NAS_STATIC/index.html $NAS_STATIC/index.mobile.html"

echo "=== 3. 验证 ==="
curl -sk -o /dev/null -w "HTTP %{http_code}" "https://${NAS_HOST}:4043/index.mobile.html"
echo ""
echo "=== 完成：无需重启，iPhone 杀掉 App 重开即生效 ==="
