# FileExpress - 极简文件快递柜
**Author: adou**

一个极简、安全、临时的文件传送枢纽。支持公开文本广场分享与基于 6 位验证码的私密文件柜。

## 🌟 核心特色
- 🔒 **全流程加密**：所有私密文件在后端均经过 **AES-256-GCM** 工业级加密存储。即便数据库文件泄露，无密钥也无法读取内容。
- ⚙️ **高度可定制**：支持通过环境变量自定义项目名称、副标题、以及文件上传体积限制。
- 🛡️ **智能熔断机制**：内置存储限额检查（默认为 1GB）。当容量接近上限时，系统会自动清理过期文件；若清理后仍超限，将暂时阻断新上传以保护服务器稳定。
- 📱 **响应式设计**：针对手机端进行了深度优化，新增 **二维码 (QR Code)** 扫码取件功能，并针对小屏布局进行了滚动区域优化，确保操作顺滑。
- 🛡️ **高性能本地存储**：在本地模式下采用分离式存储（Metadata 存 JSON，加密文件存二进制目录），极大提升了移动端上传大图片或文件的稳定性。
- 🛡️ **灵活的存储适配**：默认采用高性能本地存储（Metadata 存 JSON，加密文件存二进制目录），并具备适配 Cloudflare D1/KV/R2 云原生存储的架构潜力。
- 🛡️ **安全销毁机制**：
  - **私密柜**：支持 JPG, PNG, TXT, MD, ZIP 格式。提取 5 次或超过预设时长立即永久销毁。
  - **公开模式**：极简文本分享，有效期固定为 3 天。
- 🌓 **自适应主题**：支持中英文切换，适配深色/浅色模式，采用 Inter 与 JetBrains Mono 字体，观感自然。

## 🛠️ 技术栈
- **前端 (Frontend)**: React 18, Vite, Tailwind CSS, Framer Motion, Lucide React
- **后端 (Backend)**: Node.js (Express), Multer, Crypto (AES-256-GCM)
- **存储 (Storage)**: 本地存储 (Metadata: JSON / Binary: Filesystem) / 预留 Cloudflare D1/KV 接口

## ⚙️ 环境变量配置 (.env)

你可以通过设置环境变量来个性化你的快递柜：

| 变量名 | 描述 | 默认值 |
| :--- | :--- | :--- |
| `APP_NAME` | 项目名称 | File Express |
| `APP_SUBTITLE` | 首页副标题 | 极简、安全、临时的文件传输中心 |
| `MAX_SINGLE_FILE_SIZE_MB` | 普通文件大小限制 (MB) | 10 |
| `MAX_ZIP_SIZE_MB` | ZIP 压缩包大小限制 (MB) | 50 |
| `MAX_TOTAL_STORAGE_MB` | 全局存储容量配额 (MB) | 1024 |
| `STORAGE_ENCRYPTION_KEY` | **关键：AES 加密密钥** | (随机 UUID) |

> **注意**：如果修改了 `STORAGE_ENCRYPTION_KEY`，之前已存入的旧文件将因无法解密而失效，请在初始化项目时即设置好该值。

## 🚀 部署方案详解

### 方案 A: 标准 VPS / 云服务器 (Node.js)
这是最稳健且支持大文件存储（超过 KV 限制）的推荐方式。

1. **准备环境**: 确保服务器安装了 Node.js 18+。
2. **克隆代码到服务器**:
   ```bash
   git clone <你的项目仓库地址>
   cd file-express
   ```
3. **安装依赖与构建**:
   ```bash
   npm install
   npm run build
   ```
4. **配置环境变量**: 
   创建并修改 `.env` 文件，特别是设置 `STORAGE_ENCRYPTION_KEY` 为一个持久的随机字符串。
5. **使用 PM2 持久化运行**:
   ```bash
   # 安装 PM2
   npm install -g pm2
   # 启动项目
   pm2 start dist/server.cjs --name "file-express"
   ```
6. **反向代理 (可选推荐)**: 建议使用 Nginx 将 80/443 端口转发到 3000 端口，并配置 SSL 证书。

---

### 方案 B: Cloudflare 生态 (Pages + Workers + D1)
由于 Cloudflare Workers 环境的特殊性（无本地文件系统），需要对后端逻辑做轻微适配。

#### 1. 前端部署 (Cloudflare Pages)
- 将本项目关联至 Cloudflare Pages。
- 构建设置:
  - Framework preset: `Vite`
  - Build command: `npm run build`
  - Output directory: `dist`

#### 2. 后端部署 (Cloudflare Workers)
- **数据库 (D1)**: 在控制台创建 D1 数据库，并在 Worker 中绑定。修改 `dbOperation` 使用 `env.DB.prepare(...)`。
- **对象存储 (KV/R2)**:
  - 对于小文件 (<25MB) 或元数据，可使用 **KV**。
  - 对于大文件，必须使用 **R2**。修改 `saveLocalFile` 为 `env.BUCKET.put(id, buffer)`。
- **适配层**: 由于 Workers 不支持 `express.listen`，建议使用 `hono` 或转换器将 Express 应用包装为 Fetch Handler。

#### 3. 环境变量
在 Cloudflare Dashboard 的 Workers 设置中添加：
- `STORAGE_ENCRYPTION_KEY`: 用于 AES 加密。

---

## 🚀 快速启动 (本地开发)

1. **安装依赖**: `npm install`
2. **构建项目**: `npm run build`
3. **启动服务**: `npm start` (默认端口 3000)

## 📄 许可与版权
本项目作者为 **adou**。代码逻辑清晰，适合作为个人临时传件工具或学习全栈开发的参考案例。
