#!/bin/bash
# =========================================================================
# docker-deploy.sh — VPS 一键部署 File Express (Docker)
# 用法: bash docker-deploy.sh
# =========================================================================
set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${GREEN}=== File Express Docker 一键部署 ===${NC}"

# 1. 检查 Docker
if ! docker info &>/dev/null; then
    echo -e "${RED}Docker 未运行，请先安装并启动 Docker。${NC}"
    echo "Ubuntu/Debian: curl -fsSL https://get.docker.com | bash"
    exit 1
fi
echo -e "${GREEN}✓ Docker 运行中${NC}"

# 2. 准备数据目录
mkdir -p local_storage
if [ ! -f local_db.json ]; then
    echo '{"files": {}}' > local_db.json
fi
chmod 777 local_storage local_db.json 2>/dev/null || true
echo -e "${GREEN}✓ 数据目录已就绪${NC}"

# 3. 生成 .env（如不存在）
if [ ! -f .env ]; then
    ENC_KEY=$(openssl rand -hex 16 2>/dev/null || cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
    JWT_KEY=$(openssl rand -hex 16 2>/dev/null || cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1)
    cat <<EOF > .env
NODE_ENV=production
APP_PORT=3000
APP_NAME=File Express
APP_SUBTITLE=极简、安全、临时的文件传输中心
MAX_SINGLE_FILE_SIZE_MB=10
MAX_ZIP_PAYLOAD_SIZE_MB=50
MAX_TOTAL_STORAGE_MB=1024
STORAGE_ENCRYPTION_KEY=$ENC_KEY
JWT_SECRET=$JWT_KEY
MAX_STORAGE_HOURS=24
MAX_DOWNLOADS=100
EOF
    echo -e "${GREEN}✓ .env 已生成（端口 3000，密钥随机）${NC}"
else
    echo -e "${GREEN}✓ .env 已存在${NC}"
fi

# 4. 构建并启动
echo -e "${YELLOW}正在编译 Docker 镜像并启动容器...${NC}"
DOCKER_BUILDKIT=1 docker compose up -d --build

# 5. 等待容器就绪
sleep 3
if docker compose ps | grep -q "Up"; then
    echo ""
    echo -e "${GREEN}=========================================="
    echo "  ✓ 部署成功！"
    echo "  访问地址: http://$(curl -s ifconfig.me 2>/dev/null || echo '你的VPS IP'):${APP_PORT:-3000}"
    echo "==========================================${NC}"
else
    echo -e "${RED}容器未正常运行，查看日志：docker compose logs${NC}"
fi
