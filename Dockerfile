# ==== Stage 1: 构建阶段 (Builder) ====
FROM node:22-alpine AS builder

# 设置工作目录
WORKDIR /app

# 国内或 dl-cdn 极慢时: docker compose build --build-arg USE_CN_APK_MIRROR=1
ARG USE_CN_APK_MIRROR=0
RUN if [ "$USE_CN_APK_MIRROR" = "1" ]; then \
      sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories; \
    fi

# better-sqlite3 等在 prebuild 失败时需本地编译（node-gyp）
RUN apk add --no-cache python3 make g++

# 仅拷贝包配置并安装所有依赖项（利用 Docker 缓存层）
COPY package.json package-lock.json ./
# 使用官方镜像内已带的头文件，避免 node-gyp 访问 unofficial-builds.nodejs.org（部分网络下会 DNS 失败）
ENV npm_config_nodedir=/usr/local
RUN npm ci

# 拷贝项目源代码并执行 TypeScript 编译；去掉 devDependencies 以减小复制到运行阶段的体积
COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ==== Stage 2: 生产运行阶段 (Runner) ====
FROM node:22-alpine AS runner

WORKDIR /app

# ── Puppeteer Chrome 依赖 ──────────────────────────────────────────────────────
# Alpine 默认源 chromium 版本较旧，建议用腾讯云镜像或官方源
RUN apk add --no-cache \
        chromium \
        chromium-chromedriver \
        nss \
        freetype \
        harfbuzz \
        fontconfig \
        ttf-freefont \
        udev \
    && rm -rf /var/cache/apk/* /tmp/*

# 让 Puppeteer 找到系统 Chrome（Alpine 官方 chromium 包路径）
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1
# ─────────────────────────────────────────────────────────────────────────────

# 设置为生产环境
ENV NODE_ENV=production

# 增大 Node.js 堆内存上限，防止日志文件过大时加载 OOM（tesseract.js / js-tiktoken 初始化也有一定内存需求）
ENV NODE_OPTIONS="--max-old-space-size=4096"

# 出于安全考虑，避免使用 root 用户运行服务
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 cursor

# 包清单（运行时需要，例如入口读取版本号）
COPY package.json package-lock.json ./

# 从 builder 拷贝已编译的原生模块与生产依赖（避免运行阶段再 npm ci 触发 node-gyp）
COPY --from=builder --chown=cursor:nodejs /app/node_modules ./node_modules

# 从 builder 阶段拷贝编译后的产物
COPY --from=builder --chown=cursor:nodejs /app/dist ./dist

# 拷贝前端静态资源（日志查看器 Web UI）
COPY --chown=cursor:nodejs public ./public

# 创建日志目录并授权
RUN mkdir -p /app/logs && chown cursor:nodejs /app/logs

# 注意：config.yaml 不打包进镜像，通过 docker-compose volumes 挂载
# 如果未挂载，服务会使用内置默认值 + 环境变量

# 切换到非 root 用户
USER cursor

# 声明对外暴露的端口和持久化卷
EXPOSE 3010
VOLUME ["/app/logs"]

# 启动服务
CMD ["npm", "start"]
