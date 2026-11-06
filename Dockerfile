# 多阶段构建：client 构建 → server 构建 → 运行镜像
# 回滚 = 切回上一个镜像 tag

# ---- 阶段 1：构建前端 ----
FROM node:22-alpine AS client-build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
RUN npm run build

# ---- 阶段 2：构建服务端 ----
FROM node:22-alpine AS server-build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/ ./
RUN npm run build

# ---- 阶段 3：运行 ----
FROM node:22-alpine AS runtime
# WORKDIR 必须是 server 包根：npm ci 只认当前目录的 package.json/package-lock.json
# （2026-10-24 修复：此前 WORKDIR /app 而 package.json 拷到 ./server/，npm ci 直接失败）
WORKDIR /app/server
ENV NODE_ENV=production
# 容器内必须绑 0.0.0.0：默认值是 127.0.0.1（安全默认，见 env.ts），绑死回环
# 的话 Docker 端口映射拿不到连接。镜像内显式放开，宿主机侧由 -p 控制暴露面。
ENV HOST=0.0.0.0
COPY server/package.json server/package-lock.json ./
# 运行态需要运行时依赖（express / zod / sqlite 等）；server/dist 非单文件打包，
# 缺失 node_modules 会导致 MODULE_NOT_FOUND。仅装生产依赖以缩小镜像。
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=server-build /app/server/dist ./dist
COPY --from=client-build /app/client/dist ./dist-client
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/app.js"]
