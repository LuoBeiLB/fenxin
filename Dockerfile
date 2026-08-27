# syntax=docker/dockerfile:1.7
# ============================================================
# 焚信 BurnMsg 后端 — 多阶段构建
#  builder: 完整装依赖 + nest build
#  runner : 只拷 prod 依赖 + dist，瘦身到 ~250MB
# ============================================================

ARG NODE_VERSION=20.18.0
ARG PNPM_VERSION=11.17.0

# ---------- 阶段 1：构建产物 ----------
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION

# pnpm 通过 corepack 启用（与本地版本一致可避免 lockfile 漂移）
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

WORKDIR /app

# 1) 装依赖（先拷贝 lockfile，最大化层缓存）
COPY package.json pnpm-lock.yaml* pnpm-workspace.yaml* .npmrc* ./
RUN pnpm install --frozen-lockfile

# 2) 拷贝源码 + 构建
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN pnpm run build && pnpm prune --prod

# ---------- 阶段 2：运行时镜像 ----------
FROM node:${NODE_VERSION}-alpine AS runner
ARG PNPM_VERSION

# 系统依赖：argon2 编译需要 python3 + make + g++（alpine 自带）；wget 用于 healthcheck
RUN apk add --no-cache wget tini

ENV NODE_ENV=production \
    PORT=9091 \
    UPLOAD_DIR=/app/uploads

# non-root 运行（Argon2 启动期会读 /dev/shm，root 反而 OK，但非 root 更安全）
RUN addgroup -S app && adduser -S app -G app
WORKDIR /app
RUN mkdir -p /app/uploads && chown -R app:app /app

# 拷贝构建产物 + prod node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json

USER app
EXPOSE 9091

# tini 收僵尸进程 + 转发信号
ENTRYPOINT ["/sbin/tini", "--"]

# 健康检查：仅 TCP 探测端口（/health 也可，但 healthcheck 在 DB 不可用时会误报）
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:9091/api/v1/health >/dev/null 2>&1 || exit 1

CMD ["node", "dist/main.js"]
