#!/bin/bash

# =========================================================================
# 文件快递柜 (File Express) 专属 Docker 极速部署运维工具 (FE CLI)
# 运行方式: chmod +x fe.sh && ./fe.sh
# 纯 Docker 命令，零依赖 compose
# =========================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DB_FILE="$SCRIPT_DIR/local_db.json"
STORAGE_DIR="$SCRIPT_DIR/local_storage"
IMAGE_CACHE="$SCRIPT_DIR/.image_cache"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

# ---- 工具函数 ----

generate_random_secret() {
    if command -v openssl &>/dev/null; then
        openssl rand -hex 16
    else
        cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1
    fi
}

load_env() {
    if [ -f "$ENV_FILE" ]; then
        export $(grep -v '^#' "$ENV_FILE" | xargs)
    fi
}

save_env_var() {
    local key=$1 value=$2
    touch "$ENV_FILE"
    if grep -q "^$key=" "$ENV_FILE"; then
        if [ "$(uname)" = "Darwin" ]; then
            sed -i "" "s|^$key=.*|$key=$value|" "$ENV_FILE"
        else
            sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
        fi
    else
        echo "$key=$value" >> "$ENV_FILE"
    fi
}

generate_default_env() {
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${YELLOW}未检测到现有环境配置，正在同级目录下自动定制专属 .env 配置文件...${NC}"
        local rand_enc=$(generate_random_secret)
        local rand_jwt=$(generate_random_secret)
        cat <<EOF > "$ENV_FILE"
NODE_ENV=production
PORT=3000
APP_NAME=File Express
APP_SUBTITLE=极简、安全、临时的文件传输中心
MAX_SINGLE_FILE_SIZE_MB=10
MAX_ZIP_PAYLOAD_SIZE_MB=50
MAX_TOTAL_STORAGE_MB=1024
STORAGE_ENCRYPTION_KEY=$rand_enc
JWT_SECRET=$rand_jwt
MAX_STORAGE_HOURS=24
MAX_DOWNLOADS=100
EOF
        echo -e "${GREEN}✓ .env 配置文件生成成功（端口 ${YELLOW}3000${GREEN}，密钥随机）${NC}"
        sleep 1
    fi
}

get_disk_free() {
    df -h "$SCRIPT_DIR" | awk 'NR==2 {print $4}'
}

get_recommended_storage() {
    local available_kb=$(df -k "$SCRIPT_DIR" | awk 'NR==2 {print $4}')
    local available_gb=$((available_kb / 1024 / 1024))
    local recommended=$((available_gb * 4 / 10))
    [ "$recommended" -lt 1 ] && recommended=1
    echo $recommended
}

ensure_docker_env() {
    if ! command -v docker &>/dev/null; then
        echo -e "${YELLOW}Docker 未安装，正在自动安装...${NC}"
        if curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun; then
            echo -e "${GREEN}✓ Docker 安装完成${NC}"
        else
            echo -e "${RED}❌ 自动安装失败，请手动安装 Docker${NC}"
            exit 1
        fi
    fi

    if ! docker info &>/dev/null; then
        echo -e "${YELLOW}Docker daemon 未运行，尝试启动...${NC}"
        if command -v systemctl &>/dev/null; then
            sudo systemctl start docker 2>/dev/null || true
        elif command -v service &>/dev/null; then
            sudo service docker start 2>/dev/null || true
        fi
        sleep 2
        if ! docker info &>/dev/null; then
            echo -e "${RED}❌ Docker daemon 无法启动${NC}"
            exit 1
        fi
    fi
    echo -e "${GREEN}✓ Docker 引擎运行正常${NC}"
}

# 记录/读取当前部署的镜像，方便升级重启时复用
save_image() { echo "$1" > "$IMAGE_CACHE"; }
get_image() {
    if [ -f "$IMAGE_CACHE" ]; then
        cat "$IMAGE_CACHE"
    else
        # 从运行中的容器推测
        docker inspect file-express --format '{{.Config.Image}}' 2>/dev/null || echo ""
    fi
}

ensure_data_dirs() {
    mkdir -p "$STORAGE_DIR"
    if [ ! -f "$DB_FILE" ]; then
        echo '{"files": {}}' > "$DB_FILE"
    fi
    chmod 777 "$STORAGE_DIR" "$DB_FILE" 2>/dev/null || true
}

CACHE_IP_FILE="$SCRIPT_DIR/.external_ip"

refresh_public_ip() {
    if command -v curl &>/dev/null; then
        local ip=$(curl -s --max-time 2 ifconfig.me 2>/dev/null || curl -s --max-time 2 ip.sb 2>/dev/null)
        [ -n "$ip" ] && echo "$ip" > "$CACHE_IP_FILE"
    fi
}

show_access_urls() {
    load_env
    local port=${PORT:-3000}

    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qE 'file-express(-app)?'; then
        echo -e "应用状态          : ${YELLOW}⚠ 未部署（选菜单 2 部署）${NC}"
        return
    fi

    echo -e "应用状态          : ${GREEN}● 运行中${NC}"
    local local_ip=$(hostname -I | awk '{print $1}')
    [ -z "$local_ip" ] && local_ip="127.0.0.1"
    echo -e "应用内网访问地址  : ${GREEN}http://${local_ip}:${port}${NC}"

    if [ -f "$CACHE_IP_FILE" ]; then
        echo -e "应用公网访问地址  : ${GREEN}http://$(cat "$CACHE_IP_FILE"):${port}${NC}"
    else
        refresh_public_ip
        [ -f "$CACHE_IP_FILE" ] && echo -e "应用公网访问地址  : ${GREEN}http://$(cat "$CACHE_IP_FILE"):${port}${NC}"
    fi

    if [ "$port" != "80" ] && [ "$port" != "443" ]; then
        echo -e "${YELLOW}📌 如无法访问，请检查安全组/防火墙是否放行端口 ${port}${NC}"
    fi
}

# ---- 菜单 1：项目配置 ----

project_config() {
    generate_default_env
    while true; do
        load_env
        clear
        echo -e "${BLUE}====================================================="
        echo -e "         🐳 File Express 配置中心                    "
        echo -e "=====================================================${NC}"
        echo -e "配置文件: ${YELLOW}$ENV_FILE${NC}"
        echo -e "-----------------------------------------------------"
        echo -e " 1. 应用名称      : ${GREEN}${APP_NAME:-File Express}${NC}"
        echo -e " 2. 副标题        : ${GREEN}${APP_SUBTITLE:-极简、安全、临时的文件传输中心}${NC}"

        local quota_mb=${MAX_TOTAL_STORAGE_MB:-1024}
        local quota_gb=$(awk "BEGIN {printf \"%.1f\", $quota_mb / 1024}")
        echo -e " 3. 存储配额      : ${GREEN}${quota_gb} GB${NC} (可用: $(get_disk_free))"
        echo -e " 4. 单文件上限    : ${GREEN}${MAX_SINGLE_FILE_SIZE_MB:-10} MB${NC}"
        echo -e " 5. ZIP 上限      : ${GREEN}${MAX_ZIP_PAYLOAD_SIZE_MB:-50} MB${NC}"
        echo -e " 6. 映射端口      : ${GREEN}${PORT:-3000}${NC}"
        echo -e " 7. 保存时长      : ${GREEN}${MAX_STORAGE_HOURS:-24} 小时${NC}"
        echo -e " 8. 提取上限      : ${GREEN}${MAX_DOWNLOADS:-100} 次${NC}"
        echo -e " 9. 加密密钥      : ${YELLOW}${STORAGE_ENCRYPTION_KEY:-未设置}${NC}"
        echo -e "10. JWT 密钥      : ${YELLOW}${JWT_SECRET:-默认}${NC}"
        echo -e "-----------------------------------------------------"
        echo -e " s. 保存返回 | q. 放弃返回"
        echo -e "-----------------------------------------------------"

        read -p "请输入编号 (1-10, s/q): " cfg_choice
        case $cfg_choice in
            1) read -p "应用名称: " v; [ -n "$v" ] && save_env_var "APP_NAME" "$v" ;;
            2) read -p "副标题: " v; [ -n "$v" ] && save_env_var "APP_SUBTITLE" "$v" ;;
            3)
                local rec=$(get_recommended_storage)
                read -p "存储配额 (GB) [推荐 $rec]: " v
                [ -z "$v" ] && v=$rec
                save_env_var "MAX_TOTAL_STORAGE_MB" "$((v * 1024))"
                ;;
            4) read -p "单文件上限 (MB): " v; [ -n "$v" ] && save_env_var "MAX_SINGLE_FILE_SIZE_MB" "$v" ;;
            5) read -p "ZIP 上限 (MB): " v; [ -n "$v" ] && save_env_var "MAX_ZIP_PAYLOAD_SIZE_MB" "$v" ;;
            6)
                read -p "宿主机端口: " v
                if [ -n "$v" ]; then
                    save_env_var "PORT" "$v"
                    echo -e "\n${YELLOW}⚠ 端口已更新为 $v，需重建容器生效${NC}"
                    read -p "是否立即重建？(Y/n): " rc
                    if [ "$rc" != "n" ] && [ "$rc" != "N" ]; then
                        load_env
                        local img=$(get_image)
                        docker stop file-express 2>/dev/null && docker rm file-express 2>/dev/null || true
                        docker run -d --name file-express --restart always \
                            -p "${PORT:-3000}:3000" \
                            --env-file "$ENV_FILE" \
                            -e PORT=3000 \
                            -v "$STORAGE_DIR:/app/local_storage" \
                            -v "$DB_FILE:/app/local_db.json" \
                            "$img" && save_image "$img"
                        echo -e "${GREEN}✓ 容器已用新端口重建${NC}"
                        refresh_public_ip
                        echo ""; show_access_urls; sleep 2
                    fi
                fi
                ;;
            7) read -p "保存时长 (小时): " v; [ -n "$v" ] && save_env_var "MAX_STORAGE_HOURS" "$v" ;;
            8) read -p "提取上限 (次): " v; [ -n "$v" ] && save_env_var "MAX_DOWNLOADS" "$v" ;;
            9) read -p "加密密钥: " v; [ -n "$v" ] && save_env_var "STORAGE_ENCRYPTION_KEY" "$v" ;;
            10) read -p "JWT 密钥: " v; [ -n "$v" ] && save_env_var "JWT_SECRET" "$v" ;;
            s|q) break ;;
            *) echo -e "${RED}❌ 无效编号${NC}"; sleep 1 ;;
        esac
    done
}

# ---- 菜单 2：安装部署 ----

deploy_version() {
    clear
    echo -e "${BLUE}====================================================="
    echo -e "       ⚡ File Express 一键部署                      "
    echo -e "=====================================================${NC}"

    ensure_docker_env
    generate_default_env
    load_env
    ensure_data_dirs

    local default_image="ghcr.io/alivedou/fileexpress:latest"

    echo -e "当前镜像默认值: ${GREEN}$default_image${NC}"
    read -p "输入镜像地址 [回车使用默认]: " custom_image
    local target_image="${custom_image:-$default_image}"

    echo -e "\n${BLUE}>>> 拉取镜像: $target_image${NC}"
    if ! docker pull "$target_image"; then
        echo -e "${RED}❌ 镜像拉取失败${NC}"
        echo -e "  1. 检查镜像名是否正确"
        echo -e "  2. GHCR 在国内可能较慢，多试几次"
        echo -e "  3. 确认 GitHub Actions 已触发构建"
        sleep 3; return
    fi
    echo -e "${GREEN}✓ 镜像拉取完成${NC}"

    echo -e "${YELLOW}停旧容器、启动新容器...${NC}"
    docker stop file-express 2>/dev/null && docker rm file-express 2>/dev/null || true

    if ! docker run -d --name file-express --restart always \
            -p "${PORT:-3000}:3000" \
            --env-file "$ENV_FILE" \
            -e PORT=3000 \
        -v "$STORAGE_DIR:/app/local_storage" \
        -v "$DB_FILE:/app/local_db.json" \
        "$target_image"; then
        echo -e "${RED}❌ 容器启动失败！${NC}"
        echo -e "查看日志: docker logs file-express"
        sleep 3; return
    fi

    save_image "$target_image"
    echo -e "\n${GREEN}★ 部署成功！${NC}"
    refresh_public_ip
    echo ""; show_access_urls
    read -p "按 Enter 返回主菜单..." dummy
}

# ---- 菜单 3：运行状态 ----

check_status() {
    clear
    echo -e "${BLUE}====================================================="
    echo -e "         🔍 容器运行状态                              "
    echo -e "=====================================================${NC}"

    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qE 'file-express(-app)?'; then
        echo -e "${YELLOW}容器未运行${NC}"
        echo -e "-----------------------------------------------------"
        docker ps -a --filter "name=file-express" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "(无记录)"
    else
        echo -e "${GREEN}● 运行中${NC}"
        echo -e "-----------------------------------------------------"
        docker ps --filter "name=file-express" --format "table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}"
        echo -e "-----------------------------------------------------"
        echo -e "资源占用:"
        docker stats --no-stream --filter "name=file-express" --format "table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.NetIO}}" 2>/dev/null
    fi

    echo -e "-----------------------------------------------------"
    show_access_urls
    echo -e "-----------------------------------------------------"
    read -p "按 Enter 返回主菜单..." dummy
}

# ---- 菜单 4：实时日志 ----

view_logs() {
    clear
    echo -e "${BLUE}====================================================="
    echo -e "         📋 实时日志 (Ctrl+C 退出)                    "
    echo -e "=====================================================${NC}"

    if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -qE 'file-express(-app)?'; then
        echo -e "${YELLOW}容器未运行，显示最近一次日志:${NC}"
        docker logs --tail=50 file-express 2>/dev/null || echo "(无日志)"
        read -p "按 Enter 返回..." dummy
    else
        docker logs -f --tail=100 file-express
    fi
}

# ---- 菜单 5：数据重置 ----

data_reset() {
    clear
    echo -e "${RED}====================================================="
    echo -e "             🚨 数据重置（不可撤销）                   "
    echo -e "=====================================================${NC}"
    echo -e "此操作将清空:"
    echo -e "  - 所有已上传文件 ($STORAGE_DIR/)"
    echo -e "  - 提取码与元数据 ($DB_FILE)"
    echo -e "${GREEN}保留: .env 配置（端口、密钥等）${NC}"
    echo -e "-----------------------------------------------------"

    read -p "确认重置？输入大写 CONFIRM: " cf
    if [ "$cf" != "CONFIRM" ]; then
        echo -e "${BLUE}已取消${NC}"; sleep 1; return
    fi

    echo -e "\n${YELLOW}停止容器...${NC}"
    docker stop file-express 2>/dev/null || true

    echo -e "${YELLOW}清空数据...${NC}"
    rm -rf "$STORAGE_DIR"/*
    echo '{"files": {}}' > "$DB_FILE"
    mkdir -p "$STORAGE_DIR"
    chmod 777 "$STORAGE_DIR" "$DB_FILE" 2>/dev/null || true

    echo -e "${YELLOW}重启容器...${NC}"
    docker start file-express 2>/dev/null || {
        local img=$(get_image)
        docker run -d --name file-express --restart always \
            -p "${PORT:-3000}:3000" \
            --env-file "$ENV_FILE" \
            -e PORT=3000 \
            -v "$STORAGE_DIR:/app/local_storage" \
            -v "$DB_FILE:/app/local_db.json" \
            "$img" 2>/dev/null
    }

    echo -e "\n${GREEN}✓ 数据已重置${NC}"
    sleep 2
}

# ---- 菜单 6：彻底卸载 ----

uninstall_all() {
    clear
    echo -e "${RED}====================================================="
    echo -e "             🌋 彻底卸载                              "
    echo -e "=====================================================${NC}"
    echo -e "此操作将:"
    echo -e "  1. 停止并删除容器"
    echo -e "  2. 删除全部镜像"
    echo -e "  3. 删除所有数据文件（local_storage/、local_db.json）"
    echo -e "  4. 删除配置文件 (.env)"
    echo -e "-----------------------------------------------------"

    read -p "输入 UNINSTALL 确认: " cf
    if [ "$cf" != "UNINSTALL" ]; then
        echo -e "${BLUE}已取消${NC}"; sleep 1; return
    fi

    echo -e "\n${YELLOW}停止并删除容器...${NC}"
    docker stop file-express file-express-app 2>/dev/null || true
    docker rm file-express file-express-app 2>/dev/null || true

    # 删除所有相关容器（按镜像名）
    local cids=$(docker ps -a --filter "ancestor=ghcr.io/alivedou/fileexpress" -q 2>/dev/null)
    [ -n "$cids" ] && docker stop $cids 2>/dev/null && docker rm $cids 2>/dev/null || true

    echo -e "${YELLOW}删除镜像...${NC}"
    docker rmi ghcr.io/alivedou/fileexpress 2>/dev/null || true
    # 删除无标签悬空镜像
    docker image prune -f 2>/dev/null || true

    echo -e "${YELLOW}删除数据文件...${NC}"
    [ -d "$STORAGE_DIR" ] && rm -rf "$STORAGE_DIR"
    [ -f "$DB_FILE" ] && rm -f "$DB_FILE"
    [ -f "$ENV_FILE" ] && rm -f "$ENV_FILE"
    [ -f "$IMAGE_CACHE" ] && rm -f "$IMAGE_CACHE"
    [ -f "$CACHE_IP_FILE" ] && rm -f "$CACHE_IP_FILE"

    echo -e "\n${RED}✓ 已彻底卸载，无残留${NC}"
    sleep 3
    exit 0
}

# ---- 主菜单 ----

while true; do
    clear
    echo -e "${GREEN}====================================================="
    echo -e "      🐳 File Express 运维控制台                      "
    echo -e "      作者: ${YELLOW}adou${NC}"
    echo -e "      仓库: ${BLUE}https://github.com/alivedou/FileExpress${NC}"
    echo -e "=====================================================${NC}"
    echo -e "路径: ${YELLOW}$SCRIPT_DIR${NC}"
    echo -e "-----------------------------------------------------"
    show_access_urls
    echo -e "-----------------------------------------------------"
    echo -e "1. ⚙️  项目配置"
    echo -e "2. ⚡ 安装部署"
    echo -e "3. 🔍 运行状态"
    echo -e "4. 📋 实时日志"
    echo -e "5. 🧹 数据重置"
    echo -e "6. ❌ 彻底卸载"
    echo -e "7. 🚪 退出"
    echo -e "-----------------------------------------------------"
    read -p "请选择 (1-7): " mc

    case $mc in
        1) project_config ;;
        2) deploy_version ;;
        3) check_status ;;
        4) view_logs ;;
        5) data_reset ;;
        6) uninstall_all ;;
        7) echo -e "\n${BLUE}再见！${NC}"; exit 0 ;;
        *) echo -e "${RED}❌ 无效选项${NC}"; sleep 1 ;;
    esac
done
