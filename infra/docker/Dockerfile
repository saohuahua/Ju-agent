# 同一 Linux 基底安装和执行原生模块
FROM node:22.23.2-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@11.23.0
WORKDIR /app
COPY . .
# 工作区源码导出依赖 tsx 保留完整锁文件依赖
RUN test "$(node --version)" = "v22.23.2" && test "$(pnpm --version)" = "11.23.0" && pnpm install --frozen-lockfile
RUN node --import tsx --input-type=module -e "import {createMemoryDatabase} from '@aftersales/persistence'; const db=createMemoryDatabase(); db.close()"
# 安装后记录实际镜像源码 不复制宿主 Git 或预生成清单
RUN node --import tsx scripts/p10-source-manifest.ts

FROM base AS api
RUN mkdir -p /data/business /data/channel && chown -R node:node /data
ENV NODE_ENV=production
ENV P9_SOURCE_MANIFEST=/app/.p10-source.json
USER node
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]

FROM base AS web
# 浏览器地址在构建时冻结为空串 运行时改变量不能重写客户端包
ENV NEXT_PUBLIC_API_BASE="" OFFLINE_DEPLOYMENT=1 NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter web build
RUN chown -R node:node /app/apps/web/.next
ENV NODE_ENV=production
USER node
WORKDIR /app/apps/web
CMD ["/app/apps/web/node_modules/.bin/next", "start", "-H", "0.0.0.0", "-p", "8790"]
