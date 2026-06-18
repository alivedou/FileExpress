# 🚀 File Express 阿里云部署全攻略 (V2.5.4)

这份文档旨在手把手教你如何将“文件快递柜”部署到阿里云服务器（ECS 或 轻量应用服务器）。无论你是小白还是技术大牛，按部就班操作即可 100% 成功。

---

## 🛠️ 前置准备 (无论哪种模式都要做)

在开始之前，请确保你的阿里云服务器已经安装了以下“基础设施”：

1.  **Node.js**: 建议版本 v20 或 v22。
    - 验证：输入 `node -v` 看看有没有版本号。
2.  **PM2**: 进程守护工具（让你的程序在后台跑，关掉终端也不断开）。
    - 安装：`npm install pm2 -g`
3.  **Nginx**: 反向代理服务器（处理 80/443 端口，支持大文件上传）。
4.  **安全组开门**: 
    - 登录阿里云后台 -> 安全组 -> 入方向 -> **手动添加端口**。
    - 必须开放：`3000` (应用默认端口) 和 `80` (Nginx 默认端口)。

---

## 🏗️ 模式 A：本地打包 + 手动部署 (推荐：稳定、专业)

**原理**：在你的开发机（本地电脑）打包生成 `dist` 文件夹，服务器只负责运行。

### 第一步：本地打包
1. 在本地电脑的项目根目录打开终端。
2. 执行命令：`npm run build`
3. 执行完后，你会发现多了一个 `dist` 文件夹。这就是你的“成品”。

### 第二步：上传文件
使用宝塔、FileZilla 或 `scp` 命令，将以下内容上传到服务器的目录（例如 `/opt/file-express`）：
-   📁 `dist/` (整个文件夹)
-   📄 `package.json`
-   📄 `.env` (如果没有就新建一个，见下方配置)

### 第三步：服务器安装依赖
1. 在服务器上，进入对应的目录：`cd /opt/file-express`
2. 安装生产环境依赖：`npm install --omit=dev`

### 第四步：启动应用
1. 使用 PM2 启动服务：
   ```bash
   pm2 start dist/server.cjs --name file-box
   ```
2. 保存状态，确保重启不丢失：`pm2 save`

---

## ⚡ 模式 B：全量上传 + 自动脚本部署 (最快、最省心)

**原理**：把整个项目文件夹丢上去，剩下的交给 `fe.sh`。

### 第一步：上传项目
直接把下载的整个项目压缩包（或者解压后的文件夹）上传到服务器。

### 第二步：赋予脚本权限
1. 进入项目目录，给脚本执行权力：
   ```bash
   chmod +x fe.sh
   ```

### 第三步：运行脚本
1. 执行脚本：
   ```bash
   ./fe.sh
   ```
2. **脚本会帮你做以下事**：
   - 检查并安装 Node.js 依赖。
   - 让你互动式地修改应用名称、端口、上传大小限制。
   - 自动执行 `npm run build`。
   - 自动通过 PM2 启动或重启项目。
   - 告诉你最终的访问地址。

---

## 🐳 模式 C：Docker 极速部署 (极其推荐：隔离、持久、安全)

**原理**：借助准备好的 Dockerfiles，在服务器上生成独立干净的系统环境。利用数据卷卷挂载，防止容器重建时文件丢失。

### 第一步：在阿里云服务器安装 Docker 与 Compose
如果你服务器上还没安装 Docker，直接运行以下命令：
```bash
# 1. 极速安装 Docker
curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun

# 2. 启动并设置开机自启
systemctl start docker
systemctl enable docker

# 3. 检查安装状态
docker --version
docker compose version
```

### 第二步：一键创建标准工作目录并上传配置文件
在服务器上新建工业标准应用部署目录（`/opt/file-express`），只需要在此目录下准备和上传核心配置文件：
-   📄 `docker-compose.yml`

⚠️ **特别提示**：由于 Docker 挂载非已有文件的特性，建议先创建标准主目录并提前建立空白数据目录和数据库文件，避免 Docker 错将其识别并挂载为新文件夹导致不可写报错：
```bash
mkdir -p /opt/file-express && cd /opt/file-express
mkdir -p local_storage
touch local_db.json
```

### 第三步：一键运行容器
在包含 `docker-compose.yml` 的标准目录（如 `/opt/file-express`）下执行：
```bash
docker compose up -d
```
> **小贴士**：如果是第一次运行，或想拉取最新本地代码在服务器上完全重新打包：
> - 直接在包含 `Dockerfile` 和当前项目的根目录下运行：`docker compose up -d --build`。
> - 容器启动后，即可通过访问 `http://服务器IP:3456` 畅玩运行！
> - 若需要修改映射端口（默认 3456），进入 `docker-compose.yml`，修改 `ports:` 下的 `- "3456:3000"`，比如 `- "80:3000"` 就可以直接通过 80 端口无需反向代理访问。

---

## 🌐 第四步：Nginx 配置 (让访问更优雅)

为了能通过域名或 80 端口直接访问，且支持大文件，请修改 Nginx 配置（通常在 `/etc/nginx/nginx.conf` 或 `/etc/nginx/conf.d/default.conf`）：

```nginx
server {
    listen 80;
    server_name 你的域名或公网IP;

    # 关键：允许大文件上传 (如 100MB)
    client_max_body_size 100M;

    location / {
        # 转发到 Node.js 端口。
        # 127.0.0.1 代表本机。
        # 3000 必须与你在 .env 或 fe.sh 中设置的 APP_PORT 保持一致！
        proxy_pass http://127.0.0.1:3000; 
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```
修改完后执行：`nginx -s reload`。

---

## ❓ 常见问题排查 (傻瓜式 Checklist)

1.  **样式还是不出来？**
    - 检查 `vite.config.ts` 中的 `base` 是否为 `'/'`。
    - 确保浏览器没有强缓存（按下 `Ctrl + F5` 刷新）。
2.  **上传大文件报错 413？**
    - 这是 Nginx 的锅。去 Nginx 配置里加一行 `client_max_body_size 100M;`。
3.  **连接不上服务器？**
    - 检查阿里云控制台的“安全组”是否放行了 3000 和 80 端口。
4.  **字体缺失问题？**
    - 本版本已将字体切换为系统内置字体家族（Inter, system-ui），不再依赖外部 CDN，即便在断网环境下也能完美显示图标和文字。

---

祝你部署顺利！如果有任何问题，随时查看 `.env` 文件中的配置项。
