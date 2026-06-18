#!/bin/bash

# 文件快递柜 (File Express) 交互式管理工具
# 运行方式: chmod +x fe.sh && ./fe.sh

ENV_FILE=".env"
DB_FILE="local_db.json"
STORAGE_DIR="local_storage"

# 颜色定义
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 加载环境变量
load_env() {
    if [ -f "$ENV_FILE" ]; then
        export $(grep -v '^#' $ENV_FILE | xargs)
    fi
}

# 保存环境变量
save_env_var() {
    local key=$1
    local value=$2
    if grep -q "^$key=" "$ENV_FILE"; then
        sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
    else
        echo "$key=$value" >> "$ENV_FILE"
    fi
}

# 获取推荐值 (剩余空间的 40%)
get_recommended_storage() {
    # 获取当前目录所在磁盘的可利用空间 (KB)
    local available_kb=$(df -k . | awk 'NR==2 {print $4}')
    local available_gb=$((available_kb / 1024 / 1024))
    # 计算 40% (直接使用 bash 整数运算)
    local recommended=$((available_gb * 4 / 10))
    # 至少保留 1GB
    if [ "$recommended" -lt 1 ]; then recommended=1; fi
    echo $recommended
}

# 获取磁盘剩余大小
get_disk_free() {
    df -h . | awk 'NR==2 {print $4}'
}

# 1. 项目配置菜单
project_config() {
    while true; do
        load_env
        clear
        echo -e "${BLUE}========================================"
        echo -e "       项目配置详情 (Config Details)     "
        echo -e "=======================================${NC}"
        
        # 显示当前值
        echo -e "1. 应用名称: ${GREEN}${APP_NAME:-"File Express (默认)"}${NC}"
        echo -e "2. 副标题  : ${GREEN}${APP_SUBTITLE:-"极简安全的文件传输中心"}${NC}"
        
        # 计算当前存储配额显示
        local current_quota_mb=${MAX_TOTAL_STORAGE_MB:-1024}
        local current_quota_gb=$(awk "BEGIN {printf \"%.1f\", $current_quota_mb / 1024}")
        echo -e "3. 总存储配额: ${GREEN}${current_quota_gb} GB${NC} (系统剩余: $(get_disk_free))"
        
        echo -e "4. 单文件上限: ${GREEN}${MAX_SINGLE_FILE_SIZE_MB:-10} MB${NC}"
        echo -e "5. ZIP 包上限: ${GREEN}${MAX_ZIP_PAYLOAD_SIZE_MB:-50} MB${NC}"
        echo -e "6. 加密密钥  : ${YELLOW}${STORAGE_ENCRYPTION_KEY:-"未设置"}${NC}"
        echo -e "7. 自定义端口: ${GREEN}${APP_PORT:-3000}${NC}"
        echo -e "8. 最大存储时长: ${GREEN}${MAX_STORAGE_HOURS:-24} 小时${NC}"
        echo -e "9. 最大提取次数: ${GREEN}${MAX_DOWNLOADS:-100} 次${NC}"
        echo -e "----------------------------------------"
        echo -e "s. 保存并返回 | q. 直接返回"
        echo -e "----------------------------------------"
        echo -e "${YELLOW}注: 修改端口后需重启应用生效。${NC}"
        echo -e "----------------------------------------"
        
        read -p "请输入要修改的项目编号: " cfg_choice
        
        case $cfg_choice in
            1)
                read -p "输入应用名称 (回车设为默认): " input_val
                [ -z "$input_val" ] && input_val="File Express"
                save_env_var "APP_NAME" "$input_val"
                ;;
            2)
                read -p "输入副标题 (回车设为默认): " input_val
                [ -z "$input_val" ] && input_val="极简、安全、临时的文件传输中心"
                save_env_var "APP_SUBTITLE" "$input_val"
                ;;
            3)
                local rec=$(get_recommended_storage)
                echo -e "当前磁盘剩余约 $(get_disk_free)。"
                read -p "输入最大占用空间 (GB) [推荐为剩余 40%: $rec GB]: " input_val
                [ -z "$input_val" ] && input_val=$rec
                local mb_val=$((input_val * 1024))
                save_env_var "MAX_TOTAL_STORAGE_MB" "$mb_val"
                ;;
            4)
                # 推荐值为总空间的 1/50
                local current_max=${MAX_TOTAL_STORAGE_MB:-1024}
                local rec_single=$((current_max / 50))
                read -p "输入单文件体积上限 (MB) [推荐: $rec_single MB]: " input_val
                [ -z "$input_val" ] && input_val=10
                save_env_var "MAX_SINGLE_FILE_SIZE_MB" "$input_val"
                ;;
            5)
                read -p "输入ZIP压缩包上限 (MB): " input_val
                [ -z "$input_val" ] && input_val=50
                save_env_var "MAX_ZIP_PAYLOAD_SIZE_MB" "$input_val"
                ;;
            6)
                read -p "输入加密密钥 (32位佳): " input_val
                [ ! -z "$input_val" ] && save_env_var "STORAGE_ENCRYPTION_KEY" "$input_val"
                ;;
            7)
                read -p "输入自定义运行端口 (默认 3000): " input_val
                [ -z "$input_val" ] && input_val=3000
                save_env_var "APP_PORT" "$input_val"
                ;;
            8)
                read -p "输入最大存储时长(小时) (默认 24): " input_val
                [ -z "$input_val" ] && input_val=24
                save_env_var "MAX_STORAGE_HOURS" "$input_val"
                ;;
            9)
                read -p "输入最大允许的提取次数 (默认 100): " input_val
                [ -z "$input_val" ] && input_val=100
                save_env_var "MAX_DOWNLOADS" "$input_val"
                ;;
            s|q) break ;;
            *) echo -e "${RED}无效选择${NC}" ; sleep 1 ;;
        esac
    done
}

# 2. 数据库与环境重置
init_database() {
    clear
    echo -e "${RED}严重警告: 此操作将永久删除：${NC}"
    echo -e "1. ${YELLOW}所有已上传的物理文件${NC} (local_storage/*)"
    echo -e "2. ${YELLOW}所有元数据记录${NC} (local_db.json)"
    echo -e "3. ${YELLOW}所有环境变量配置${NC} (.env - 包含加密密钥)"
    echo -e "----------------------------------------"
    read -p "你确定要执行完全重置吗？之前的文件将永远无法恢复！ (y/n): " confirm
    if [ "$confirm" == "y" ]; then
        echo -e "${BLUE}正在清理中...${NC}"
        rm -f "$DB_FILE"
        rm -f "$ENV_FILE"
        rm -rf "$STORAGE_DIR"/*
        echo -e "${GREEN}项目已完全重置。请重新运行 '项目配置' 或重新启动。${NC}"
        sleep 3
    else
        echo "操作已取消。"
        sleep 1
    fi
}

# 3. 运行应用
run_app() {
    local bg_mode=${1:-false}
    load_env
    clear
    echo -e "${GREEN}>>> 正在启动文件快递柜...${NC}"
    
    # 尝试获取本机内网 IP
    local local_ip=$(hostname -I | awk '{print $1}')
    [ -z "$local_ip" ] && local_ip="127.0.0.1"
    local port=${APP_PORT:-3000}
    
    # 极轻量公网 IP 自动检测（带短超时，防阻塞）
    local public_ip=""
    if [ -x "$(command -v curl)" ]; then
        public_ip=$(curl -s --max-time 1.5 ifconfig.me || curl -s --max-time 1.5 ip.sb || curl -s --max-time 1.5 api.ipify.org)
    fi
    
    echo -e "${BLUE}========================================"
    echo -e "      APPLICATION STARTUP SEQUENCE      "
    echo -e "=======================================${NC}"
    echo -e "本地内网/虚拟机地址: ${GREEN}http://$local_ip:$port${NC}"
    if [ ! -z "$public_ip" ]; then
        echo -e "外部公网推荐访问地址: ${GREEN}http://$public_ip:$port${NC}"
    fi
    echo -e "手机扫码或浏览器输入上方适合您网络环境的地址即可使用。"
    echo -e "----------------------------------------"
    
    # 自动安装依赖和构建
    if [ ! -d "node_modules" ]; then
        echo -e "${YELLOW}正在安装依赖 (npm install)...${NC}"
        npm install
    fi
    if [ ! -d "dist" ]; then
        echo -e "${YELLOW}正在构建应用 (npm run build)...${NC}"
        npm run build
    fi
    
    if [ "$bg_mode" = true ]; then
        echo -e "日志输出已重定向至: ${YELLOW}app.log${NC}"
        echo -e "${GREEN}应用已在后台稳定运行。${NC}"
        # 关掉任何已有的 PM2 或 nohup 残留 (如果有) 的提示，这里直接 nohup
        nohup npm start > app.log 2>&1 &
        echo $! > app.pid
        echo -e "（提示：可随时通过 'kill $(cat app.pid)' 或通过 FE 菜单停止服务）"
        read -p "按回车键返回主菜单..." dummy
    else
        echo -e "日志输出 (Ctrl+C 暂停运行并返回菜单):"
        # 启动 Node 应用挂载到前台
        npm start &
        APP_PID=$!
        
        # 捕获 Ctrl+C 并优雅关闭进程
        trap "echo -e '\n${YELLOW}检测到 Ctrl+C，正在停止应用...${NC}'; kill $APP_PID 2>/dev/null; sleep 1; return" SIGINT

        # 等待后台应用进程结束
        wait $APP_PID
        
        # 恢复 SIGINT 行为
        trap - SIGINT
        
        echo -e "\n${YELLOW}应用已停止运行。${NC}"
        read -p "按回车键返回主菜单..." dummy
    fi
}

# 停止后台运行
stop_app_bg() {
    clear
    echo -e "${YELLOW}检查后台进程...${NC}"
    if [ -f "app.pid" ]; then
        pid=$(cat app.pid)
        if ps -p $pid > /dev/null; then
            kill $pid
            echo -e "${GREEN}已成功停止后台服务 (PID: $pid)${NC}"
        else
            echo -e "后台服务未运行或已被停止。"
        fi
        rm -f app.pid
    else
        # 尝试暴力按端口或名称杀掉
        echo -e "未找到 app.pid 记录，应用可能未在后台运行。"
    fi
    sleep 1.5
}

# 高级选项
advanced_options() {
    while true; do
        clear
        echo -e "${BLUE}========================================"
        echo -e "              高级选项                   "
        echo -e "=======================================${NC}"
        echo -e "1. ${GREEN}安装全局系统命令 'fe'${NC} (支持随处唤出面板)"
        echo -e "2. ${RED}完全干净卸载整个应用${NC} (一键自毁全量清理)"
        echo -e "----------------------------------------"
        echo -e "q. 返回上级菜单"
        echo -e "----------------------------------------"
        read -p "请选择 (1-2, q): " adv_choice
        case $adv_choice in
            1)
                echo -e "${YELLOW}正在尝试安装全局命令...${NC}"
                # 尝试使用 sudo 安装到 /usr/local/bin
                sudo -n ln -sf "$(pwd)/fe.sh" /usr/local/bin/fe 2>/dev/null || ln -sf "$(pwd)/fe.sh" /usr/local/bin/fe 2>/dev/null
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}安装成功！已安装至 /usr/local/bin/fe${NC}"
                    echo -e "${GREEN}以后在系统任何位置输入 'fe' 即可呼出本管理面板。${NC}"
                else
                    echo -e "${YELLOW}无法写入 /usr/local/bin，尝试安装至当前用户目录...${NC}"
                    mkdir -p "$HOME/.local/bin"
                    ln -sf "$(pwd)/fe.sh" "$HOME/.local/bin/fe"
                    if [ $? -eq 0 ]; then
                        echo -e "${GREEN}命令已链接至 $HOME/.local/bin/fe${NC}"
                        if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
                            echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.bashrc"
                            echo -e "${YELLOW}请执行命令：source ~/.bashrc 以激活路径变量，然后再输入 'fe'！${NC}"
                        else
                            echo -e "${GREEN}以后在系统任何位置输入 'fe' 即可呼出本管理面板。${NC}"
                        fi
                    else
                        echo -e "${RED}安装失败... 请手动使用别名或直接运行 ./fe.sh${NC}"
                    fi
                fi
                read -p "按回车键继续..." dummy
                ;;
            2)
                echo -e "${RED}【极端警告】此操作将：${NC}"
                echo -e "1. 强制停止所有后台传输服务"
                echo -e "2. 永久删除所有数据库和文件缓存"
                echo -e "3. 删除系统级快捷命令"
                echo -e "4. 删除整个项目目录！此操作完全不可逆！"
                read -p "类型 'CONFIRM' 确认执行自我销毁: " confirm
                if [ "$confirm" == "CONFIRM" ]; then
                    echo -e "${YELLOW}正在中止相关进程...${NC}"
                    if [ -f "app.pid" ]; then
                        kill $(cat app.pid) 2>/dev/null
                    fi
                    sudo rm -f /usr/local/bin/fe
                    echo -e "${YELLOW}调度自毁任务中... 再见！${NC}"
                    local app_path=$(pwd)
                    cd ..
                    rm -rf "$app_path"
                    exit 0
                fi
                ;;
            q) break ;;
            *) echo -e "${RED}无效选择${NC}" ; sleep 1 ;;
        esac
    done
}

# Docker 部署管理子面板
docker_panel() {
    while true; do
        clear
        echo -e "${BLUE}========================================"
        echo -e "       Docker 极速部署运维面板          "
        echo -e "=======================================${NC}"
        echo -e "1. ⚙️ 检测与安装 Docker 环境 (自愈引擎)"
        echo -e "2. ⚡ 一键拉取 GHCR 线上已发布镜像  (由 Actions 生成)"
        echo -e "3. 🚀 一键启动 Docker Compose 容器 (后台静默)"
        echo -e "4. ⏹️ 一键关闭并清理 Docker 运行环境"
        echo -e "5. 🔄 强力重新构建并启动本地容器   (实时打包)"
        echo -e "6. 📋 查看容器状态及实时服务日志   (Ctrl+C 退出)"
        echo -e "----------------------------------------"
        echo -e "q. 返回主菜单"
        echo -e "----------------------------------------"
        
        read -p "请选择 (1-6, q): " docker_choice
        case $docker_choice in
            1)
                echo -e "${BLUE}=== 正在检测 Docker 引擎安装状态 ===${NC}"
                if ! command -v docker &> /dev/null; then
                    echo -e "${YELLOW}未检测到 Docker，正在尝试自动安装 Docker 引擎...${NC}"
                    if curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun; then
                        systemctl start docker
                        systemctl enable docker
                        echo -e "${GREEN}✓ Docker 引擎安装配置成功！${NC}"
                    else
                        echo -e "${RED}❌ 一键安装 Docker 失败，请参考 deployment.md 手动安装！${NC}"
                    fi
                else
                    echo -e "${GREEN}✓ Docker 引擎已经就绪: $(docker --version)${NC}"
                fi

                if ! docker compose version &> /dev/null && ! command -v docker-compose &> /dev/null; then
                    echo -e "${YELLOW}检测到未安装 Docker Compose，正在尝试自动安装...${NC}"
                    sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
                    sudo chmod +x /usr/local/bin/docker-compose
                    sudo ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
                    echo -e "${GREEN}✓ Docker Compose 安装成功：$(docker-compose --version)${NC}"
                else
                    echo -e "${GREEN}✓ Docker Compose 已经就绪${NC}"
                fi
                read -p "按回车键继续..." dummy
                ;;
            2)
                echo -e "${BLUE}=== 一键拉取 GHCR 镜像 ===${NC}"
                local default_owner="alivedou"
                local default_repo="FileExpress"
                if [ -d ".git" ] && command -v git &> /dev/null; then
                    local remote_url=$(git config --get remote.origin.url)
                    if [[ $remote_url =~ github.com[:/]([^/]+)/([^.]+)(\.git)? ]]; then
                        default_owner="${BASH_REMATCH[1]}"
                        default_repo="${BASH_REMATCH[2]}"
                    fi
                fi
                default_owner=$(echo "$default_owner" | tr '[:upper:]' '[:lower:]')
                default_repo=$(echo "$default_repo" | tr '[:upper:]' '[:lower:]')

                read -p "请输入宿主用户名/组织名 [默认: $default_owner]: " gh_owner
                [ -z "$gh_owner" ] && gh_owner=$default_owner
                read -p "请输入镜像仓库名 [默认: $default_repo]: " gh_repo
                [ -z "$gh_repo" ] && gh_repo=$default_repo
                read -p "请输入镜像标签Tag [默认: latest]: " gh_tag
                [ -z "$gh_tag" ] && gh_tag="latest"

                local image_path="ghcr.io/${gh_owner}/${gh_repo}:${gh_tag}"
                echo -e "${YELLOW}开始执行命令: docker pull $image_path${NC}"
                docker pull "$image_path"
                if [ $? -eq 0 ]; then
                    echo -e "${GREEN}✓ 镜像 $image_path 拉取成功！${NC}"
                    if [ -f "docker-compose.yml" ]; then
                        sed -i "s|image:.*|image: $image_path|" "docker-compose.yml"
                        echo -e "${GREEN}✓ 已经拉取回来的新镜像同步修改到了 docker-compose.yml！${NC}"
                    fi
                else
                    echo -e "${RED}❌ 镜像拉取失败。请确认 Actions 手动编译已经成功发布！${NC}"
                fi
                read -p "按回车键继续..." dummy
                ;;
            3)
                echo -e "${BLUE}=== 一键启动 Docker 服务 ===${NC}"
                local current_dir=$(pwd)
                if [ "$current_dir" != "/opt/file-express" ]; then
                    echo -e "${YELLOW}⚠️  【生产环境专业提示】"
                    echo -e "    当前运行路径为: $current_dir"
                    echo -e "    工业级生产部署强烈建议将此应用文件夹或 Compose 配置文件统一存放于 /opt/file-express 目录下执行，"
                    echo -e "    这符合 Linux 标准文件层级规范 (FHS)，并防范不慎误删宿主机保活数据。${NC}\n"
                fi
                mkdir -p local_storage
                if [ ! -f "local_db.json" ]; then
                    echo '{"files": {}}' > local_db.json
                fi
                chmod 777 local_storage local_db.json 2>/dev/null || true

                if docker compose version &> /dev/null; then
                    echo -e "${YELLOW}正在启动 Docker 容器...${NC}"
                    docker compose up -d
                elif command -v docker-compose &> /dev/null; then
                    echo -e "${YELLOW}正在启动 Docker 容器...${NC}"
                    docker-compose up -d
                else
                    echo -e "${RED}❌ 未检测到 docker compose 命令行工具，请先执行选择 1 安装。${NC}"
                fi
                sleep 2
                read -p "按回车键继续..." dummy
                ;;
            4)
                echo -e "${BLUE}=== 一键关闭并清理 Docker ===${NC}"
                if docker compose version &> /dev/null; then
                    docker compose down
                elif command -v docker-compose &> /dev/null; then
                    docker-compose down
                else
                    echo -e "${RED}❌ 未检测到 docker compose 命令行工具。${NC}"
                fi
                sleep 1.5
                ;;
            5)
                echo -e "${BLUE}=== 本地重构打包并升级 Docker 容器 ===${NC}"
                local current_dir=$(pwd)
                if [ "$current_dir" != "/opt/file-express" ]; then
                    echo -e "${YELLOW}⚠️  【生产环境专业提示】"
                    echo -e "    当前运行路径为: $current_dir"
                    echo -e "    工业级生产部署强烈建议将此应用文件夹或 Compose 配置文件统一存放于 /opt/file-express 目录下执行，"
                    echo -e "    这符合 Linux 标准文件层级规范 (FHS)，并防范不慎误删宿主机保活数据。${NC}\n"
                fi
                mkdir -p local_storage
                if [ ! -f "local_db.json" ]; then
                    echo '{"files": {}}' > local_db.json
                fi
                chmod 777 local_storage local_db.json 2>/dev/null || true

                if docker compose version &> /dev/null; then
                    docker compose up -d --build
                elif command -v docker-compose &> /dev/null; then
                    docker-compose up -d --build
                else
                    echo -e "${RED}❌ docker compose 不可用，请先修复环境。${NC}"
                fi
                sleep 2
                read -p "按回车键继续..." dummy
                ;;
            6)
                echo -e "${BLUE}=== 查看容器运行日志 ===${NC}"
                if docker compose version &> /dev/null; then
                    docker compose logs -f
                elif command -v docker-compose &> /dev/null; then
                    docker-compose logs -f
                else
                    echo -e "${YELLOW}未检测到 compose。尝试原生命令查看：${NC}"
                    docker logs -f file-express-app
                fi
                ;;
            q) break ;;
            *) echo -e "${RED}无效选择${NC}" ; sleep 1 ;;
        esac
    done
}

# 主循环
while true; do
    clear
    echo -e "${BLUE}========================================"
    echo -e "    File Express 管理工具 (FE CLI)     "
    echo -e "=======================================${NC}"
    echo -e "1. ${GREEN}项目配置${NC} (环境变量与限额)"
    echo -e "2. ${YELLOW}数据库初始化${NC} (清空已有数据)"
    echo -e "3. ${BLUE}前台运行测试${NC} (Ctrl+C 退出)"
    echo -e "4. ${GREEN}后台稳定运行${NC} (系统静默挂载)"
    echo -e "5. ${RED}停止后台运行${NC} (终结挂载进程)"
    echo -e "6. ${BLUE}高级选项${NC} (全局命令/全量卸载)"
    echo -e "7. 🐳 ${GREEN}Docker 部署面板${NC} (极其推荐一键容器运维)"
    echo -e "8. 退出菜单"
    echo -e "----------------------------------------"
    read -p "请选择 (1-8): " main_choice

    case $main_choice in
        1) project_config ;;
        2) init_database ;;
        3) run_app false ;;
        4) run_app true ;;
        5) stop_app_bg ;;
        6) advanced_options ;;
        7) docker_panel ;;
        8) echo "再见！" ; exit 0 ;;
        *) echo -e "${RED}无效选择 (1-8)${NC}" ; sleep 1 ;;
    esac
done
