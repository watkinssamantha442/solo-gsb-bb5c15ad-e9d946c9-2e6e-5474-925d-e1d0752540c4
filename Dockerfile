# 对比度调色板求解器镜像
# 多阶段构建：构建阶段自动安装依赖，运行阶段仅保留生产依赖。
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# 无 lock 文件时回退到 npm install（首次构建会自动生成依赖）。
RUN if [ -f package-lock.json ]; then npm ci --omit=dev; \
    else npm install --omit=dev; fi

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000

# 从构建阶段复制已准备好的依赖
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY examples ./examples

# 非 root 用户运行
RUN chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
