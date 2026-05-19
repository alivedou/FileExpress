# FileExpress - 极简文件快递柜
**Author: adou**

一个极简、安全、临时的文件传送枢纽。支持公开文本广场分享与基于 6 位验证码的私密文件柜。

## 🌟 核心特色
- 🔒 **全流程加密**：所有私密文件在后端均经过 **AES-256-GCM** 工业级加密存储。即便数据库文件泄露，无密钥也无法读取内容。
- ⚙️ **高度可定制**：支持通过环境变量自定义项目名称、副标题、以及文件上传体积限制。
- 🛡️ **智能熔断机制**：内置存储限额检查（默认为 1GB）。当容量接近上限时，系统会自动清理过期文件；若清理后仍超限，将暂时阻断新上传以保护服务器稳定。
- 📱 **响应式设计**：针对手机端进行了深度优化，新增 **二维码 (QR Code)** 扫码取件功能，并针对小屏布局进行了滚动区域优化，确保操作顺滑。
- 🛡️ **高性能本地存储**：在本地模式下采用分离式存储（Metadata 存 JSON，加密文件存二进制目录），极大提升了移动端上传大图片或文件的稳定性。
- 🛡️ **双轨韧性存储**：具备自动云端/本地切换能力。支持 Firebase Cloud Storage 或本地 JSON + Base64 存储模式。
- 🛡️ **安全销毁机制**：
  - **私密柜**：支持 JPG, PNG, TXT, MD, ZIP 格式。提取 5 次或超过预设时长立即永久销毁。
  - **公开模式**：极简文本分享，有效期固定为 3 天。
- 🌓 **自适应主题**：支持中英文切换，适配深色/浅色模式，采用 Inter 与 JetBrains Mono 字体，观感自然。

## 🛠️ 技术栈
- **前端 (Frontend)**: React 18, Vite, Tailwind CSS, Framer Motion, Lucide React
- **后端 (Backend)**: Node.js (Express), Multer, Crypto (AES-256-GCM)
- **存储 (Storage)**: Firebase (Firestore/Storage) 或 本地存储 (自动降级)

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

## 🚀 部署方案
本项目支持多种部署环境：

### 方案 A: 标准 VPS / 沙盒 (Node.js)
这是最简单的部署方式，利用本地存储即可实现零配置运行。
- 环境: Node.js 18+
- 命令: `npm install && npm run build && npm start`

### 方案 B: Cloudflare Workers + D1 + KV (进阶)
本项目代码逻辑已为 Cloudflare 生态提供参考：
1. **数据库层**: 可将 `dbOperation` 适配器映射至 **Cloudflare D1**。
2. **存储层**: 
   - 使用 **KV 空间** 存储加密后的 Base64 数据。
   - 使用 **R2 存储桶** (可选) 存放大型二进制文件。
3. **前端**: 兼容 **Cloudflare Pages** 静态托管。

## 🚀 快速启动

1. **安装依赖**: `npm install`
2. **构建项目**: `npm run build`
3. **启动服务**: `npm start` (默认端口 3000)

## 📄 许可与版权
本项目作者为 **adou**。代码逻辑清晰，适合作为个人临时传件工具或学习全栈开发的参考案例。
