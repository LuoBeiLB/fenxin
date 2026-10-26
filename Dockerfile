# syntax=docker/dockerfile:1.7
# ============================================================
# 焚信 BurnMsg 后端 — 多阶段构建
#  builder: 完整装依赖 + nest build
#  runner : 只拷 prod 依赖 + dist，瘦身到 ~250MB
#
# 包管理器：npm（仓库里提交的是 package-lock.json，没有 pnpm-lock.yaml）。
# 之前这里用 pnpm + --frozen-lockfile，缺 pnpm-lock.yaml 时构建会直接失败：
#   ERR_PNPM_NO_LOCKFILE  Cannot install with "frozen-lockfile" because pnpm-lock.yaml is absent
# 现在改为 npm ci，锁文件必须与 package-lock.json 一致，可复现。
# ============================================================

ARG NODE_VERSION=20.18.0

# ---------- 阶段 1：构建产物 ----------
FROM node:${NODE_VERSION}-alpine AS builder

# argon2 是原生模块：alpine 下需要编译工具链（无预编译包时走源码编译）
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 1) 装依赖（先拷 lockfile，最大化层缓存）
#    注意：显式列文件名，不要用通配符 —— 匹配不到文件时 COPY 会直接失败
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# 2) 拷贝源码 + 构建
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---------- 阶段 2：运行时镜像 ----------
FROM node:${NODE_VERSION}-alpine AS runner

# 系统依赖：wget 用于 healthcheck；tini 收僵尸进程
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
