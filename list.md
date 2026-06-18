# 🐳 Docker 部署与 GitHub Actions 自动化构建待办清单 (list.md)

以下是针对“文件快递柜”增加 Docker 部署与 GitHub Actions 手动触发生成 Docker 镜像的功能方案。本方案完全遵循安全、不改动主业务代码、增量扩展的原则开发。

---

## 📋 待办事项清单 (待用户确认后执行)

### 1. 新增 Docker 基础设施文件 [已完成]
- [x] **创建 `Dockerfile`**：由于项目是完整的 Full-Stack (React ＋ Vite 后端打包)，我们将采用**多阶段构建 (Multi-stage Build)** 以确保产物镜像极度精简（仅 ~150MB）：
  - **构建阶段**：拉取 `node:20-alpine` 依赖，安装 `devDependencies`，并执行 `npm run build` 生成 `dist/`。
  - **运行阶段**：拉取纯净 `node:20-alpine`，仅安装生产运行依赖 (`npm install --omit=dev`)，复制构建阶段得到的 `dist` 目录，通过轻量安全的用户账号 `node` 运行 `npm run start`。
- [x] **创建 `.dockerignore`**：排除 `.git`、`node_modules`、`local_storage`、`local_db.json` 等不必要及敏感文件，避免将临时上传的文件和密钥打包进 Docker 镜像。
- [x] **创建 `docker-compose.yml`**：由于快递柜有文件存储 (上传的附件) 和元数据保存 (`local_db.json`) 的持久化诉求，提供一个标准 Docker Compose 模板，帮助用户一行命令实现**数据卷持久化挂载**和端口代理。

### 2. 新增 GitHub Actions 自动化流水线 [已完成]
- [x] **创建 `.github/workflows/docker-publish.yml`**：
  - **触发机制**：配置 `workflow_dispatch` (手动触发)，并允许用户在点击运行时动态输入 `image_tag` (默认：`latest`) 和选择是否推送到 `GHCR` 镜像仓库。
  - **安全登录与打包**：使用 GitHub Actions 官方 `docker/login-action` 和 `docker/build-push-action`。
  - **多架构支持 (备选)**：支持手动选择构建 `linux/amd64` 和 `linux/arm64`（完美支持阿里云大部分 x86 机器以及 M系列 Mac、ARM 云服务器）。
  - **内置免密发布**：借助 GitHub 提供给每个仓库的专属 `GITHUB_TOKEN`，无需配置复杂的 Docker Hub 密码，直接一键安全发布到 GitHub Container Registry (`ghcr.io`) 镜像仓库。

### 3. 说明与文档补充 [已完成]
- [x] **补充 `deployment.md`**：在原有的“手动部署”和“脚本部署”基础上，增补 **“模式 C：Docker 极速部署”**。
  - 详细讲述如何在阿里云服务器上安装 Docker。
  - 详细讲解数据卷卷挂载（持久化卷映射）将物理位置映射到宿主机，防止容器重启后上传的文件丢失。
  - 提供极其简单的 `docker compose up -d` 的傻瓜式命令行教程。

### 4. 将 fe.sh 升格支持一键 Docker 一体化部署管理 [已完成]
- [x] **Docker 环境一键检测与自愈**：在 `fe.sh` 中增加 Docker 与 Docker Compose 的智能检测，发现未安装时支持一键自动安装（针对主流 CentOS/Debian/Ubuntu 阿里服务器）。
- [x] **宿主机持久化防漏机制**：容器拉起前，自动执行 `mkdir -p local_storage` 和 `touch local_db.json`，防止挂载异常。
- [x] **Docker 专属交互式子菜单**：在 `fe.sh` 中将选项 7 升级为“Docker 专属部署面板”：
  - ⚡ **选项 A：一键拉取 GHCR 线上发布的最新镜像** (对应 GitHub Actions 产出的包)。
  - 🚀 **选项 B：一键启动 Docker 服务** (全自动后台 `docker compose up -d`)。
  - ⏹️ **选项 C：一键停止 Docker 服务** (`docker compose down`)。
  - 🔄 **选项 D：本地实时打包并启动** (全自动 `docker compose up -d --build`)。
  - 📋 **选项 E：查看主容器运行日志** (`docker compose logs -f`)。
- [x] **经典/容器双模并存**：完美向下兼容原有 Node 挂载模式，提供无缝体验切换。

### 5. 标准化应用部署/安装到 `/opt/file-express` [已完成]
- [x] **优化 `docker-compose.yml` 极简通用架构**：
  - 维持 `docker-compose.yml` 中主机端持久卷挂载为相对路径（如 `./local_storage` 与 `./local_db.json`）。
  - 这允许极佳的随处即开即用（Mac、Windows、Linux），并约定将服务器上的生产工作根目录全部统一定位在 `/opt/file-express` 文件夹下。在 `/opt/file-express` 下启动时，它们将完美物理对应到 `/opt/file-express/local_storage` 和 `/opt/file-express/local_db.json`。
- [x] **精调 `deployment.md` 用户说明书**：
  - 将“模式 C：Docker 极速部署”中的所有路径示例（包括原先临时写的 `/var/www/...` 等）统一变更为标准路径 `/opt/file-express`。
  - 详细指导如何以 root 权限进行一键配置：`mkdir -p /opt/file-express`、上传配置以及执行容器拉起。
- [x] **重整 `fe.sh` 的 Docker 环境引导逻辑**：
  - 当用户在 `fe.sh` 面板中一键启动 Docker 服务时，检测当前运行环境。
  - 如果当前目录不是 `/opt/file-express`，给用户以温馨的终端控制台高亮建议：“*工业级生产部署建议将此应用文件夹或 Compose 配置文件放置在 `/opt/file-express` 路径下执行，以符合 Linux 标准文件层级规范 (FHS)*”。
  - 同时，在启动容器前自动在当前根目录通过 `mkdir -p local_storage` 和 `touch local_db.json` 并给予安全权限，确保不会出现文件夹误挂载报错。

---

### 6. `fe.sh` 极简一键 Docker 部署系统重构 [已完成]
- [x] **重构主菜单架构 (剔除 PM2/本地 Node 选项，纯化 Docker 板块)**:
  - [x] 1️⃣ **项目配置**：引导式配置、修改或读取环境变量配置文件 `.env`。无论是交互式编辑还是加载缺省值（包括自动随机生成的安全密钥 `ENCRYPTION_KEY`、`JWT_SECRET` 等），都会**直接且确定地写入到当前正在执行脚本的对应文件夹根目录（即 `fe.sh` 与 `docker-compose.yml` 所在的当前绝对路径，例如 `/opt/file-express/.env`）**。这确保宿主机配置绝对不丢失、不动荡，使得 Docker Compose 与运行容器能够 100% 自动装载、无缝承接该环境变量配置。
  - [x] 2️⃣ **全新安装部署/升级版本**：检测并自动拉取 `ghcr.io/alivedou/fileexpress:latest`，或支持交互式输入自定义的 Tag 标识。**在启动容器前，脚本将强制检测当前脚本所在目录下是否存在 `.env` 配置文件；若不存在，系统会自动在脚本同级项目目录下以默认配置项（包含全套自动随机生成的高安全强度 `ENCRYPTION_KEY`、`JWT_SECRET` 等）强制生成全新 `.env`，彻底保障开箱即用**。随后连同宿主机自愈环境（自建 `local_storage` 文件夹及补齐 `local_db.json` 数据映射）一起，优雅执行 `docker compose up -d`。
  - [x] 3️⃣ **检查容器运行状态**：调用系统级 `docker compose ps` / `docker ps` 信息展示，格式化精美呈递当前容器健康状况、网络端口。
  - [x] 4️⃣ **查看容器实时运行日志**：一键流式查看日志输出：`docker compose logs -f`，便于定位故障或传输分析。
  - [x] 5️⃣ **数据初始化 (重置)**：一键清除当前数据，优雅移除挂载文件并还原空 `local_db.json`（带有二次确认），规避操作失误。
  - [x] 6️⃣ **彻底卸载安装**：停止并彻底删除现有容器、宿主机映射数据 and 已缓存镜像，完美实现一键归零、无残留清除。
  - [x] 7️⃣ **退出脚本**。

---

## 🔎 本次方案分析

### 1. 修改位置
- `list.md` (增量追加待办任务)
- `fe.sh` (核心运维脚本流重构，将多模式切换降维极简为专属 Docker 环境运维控制台)

### 2. 影响范围
- **业务代码**：**完全无影响**。不对任何 `src/*` 下的 React 前端组件、逻辑或 `/server.ts` 运行后端做任何修改，保证业务逻辑 100% 连贯平稳。
- **运维工具 (`fe.sh`)**：运维功能将完全瘦身，从混合式支持（PM2、直接本级运行、自打包与 Docker）收敛升级为专门管理 Docker 容器的极简傻瓜式菜单，体验大幅提纯。

### 3. 风险等级
- **风险等级**：🟡 **中等风险 (Medium)**。
  - 属于对 `fe.sh` 运维控制脚本的主动升级替换，若生产环境旧服务器以前采用 Node + PM2 原生挂载运行（未使用 Docker），会无法在该新脚本上直接重启管理，需人工手动执行指令。但对于 Docker 与新进生产部署，本架构简洁优雅、自愈性强、出错率将归零。
