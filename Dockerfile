# ==========================================
# 阶段 1: 构建阶段 (Build Stage)
# 国内用户默认走镜像加速，海外用户构建时加 --build-arg REGISTRY=docker.io
# ==========================================
ARG REGISTRY=docker.m.daocloud.io
FROM ${REGISTRY}/library/node:22-alpine AS builder

WORKDIR /app

# 复制依赖文件，利用 Docker 缓存层
COPY package*.json ./

# 安装完整依赖 (包含 devDependencies 用于前端打包和 server 编译)
RUN npm ci

# 复制项目所有文件
COPY . .

# 执行打包构建
# 该脚本会自动执行 "vite build" 同步编译前端，并使用 esbuild 构建 "/app/dist/server.cjs" 后端
RUN npm run build

FROM builder AS test
CMD ["npm", "run", "test:integration"]

# ==========================================
# 阶段 2: 运行阶段 (Run Stage)
# ==========================================
ARG REGISTRY=docker.m.daocloud.io
FROM ${REGISTRY}/library/node:22-alpine AS runner

WORKDIR /app

# 设置生产环境环境变量
ENV NODE_ENV=production
ENV PORT=3000

# 建立应用所需的数据目录，并把 /app 下所有文件的所有权移交给主镜像自带的非特权用户 node
RUN mkdir -p /app/local_storage /data && \
    echo '{"files": {}}' > /app/local_db.json && \
    chown -R node:node /app /data

# 升级或复制 package.json 文件供启动脚本调用
COPY --chown=node:node package*.json ./

# 仅安装生产运行依赖，大幅精简体积
RUN npm ci --omit=dev

ARG INCLUDE_TEST_RUNNER=true
RUN if [ "$INCLUDE_TEST_RUNNER" = "true" ]; then npm install --prefix /opt/test-runner --no-save --ignore-scripts vitest@3.2.7 supertest@7.2.2; fi
ENV PATH="/opt/test-runner/node_modules/.bin:${PATH}"
ENV NODE_PATH="/opt/test-runner/node_modules"
RUN if [ "$INCLUDE_TEST_RUNNER" = "true" ]; then ln -sfn /opt/test-runner/node_modules/vitest /app/node_modules/vitest && ln -sfn /opt/test-runner/node_modules/supertest /app/node_modules/supertest; fi
COPY --from=builder --chown=node:node /app/test ./test
COPY --from=builder --chown=node:node /app/src ./src
COPY --from=builder --chown=node:node /app/lib ./lib
COPY --from=builder --chown=node:node /app/vitest.integration.config.ts ./vitest.integration.config.ts
COPY --from=builder --chown=node:node /app/tsconfig.json ./tsconfig.json

# 复制打包后的编译资源 dist 整个目录
COPY --from=builder --chown=node:node /app/dist ./dist

# 切换到安全用户
USER node

# 声明和暴露端口
EXPOSE 3000

# 采用 CMD 标准指令启动 node.js 快递柜服务
CMD ["npm", "run", "start"]
