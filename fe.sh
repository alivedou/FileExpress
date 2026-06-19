#!/bin/bash

# =========================================================================
# 文件快递柜 (File Express) 专属 Docker 极速部署运维工具 (FE CLI)
# 运行方式: chmod +x fe.sh && ./fe.sh
# =========================================================================

# 强物理锁定：获取当前运行脚本的绝对路径作为项目根目录，防止路径偏移漂移
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
DB_FILE="$SCRIPT_DIR/local_db.json"
STORAGE_DIR="$SCRIPT_DIR/local_storage"

# 优雅终端色彩定制
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m' # 清除颜色标志

# 1. 密钥随机自生成套件
generate_random_secret() {
    if command -v openssl &>/dev/null; then
        openssl rand -hex 16
    else
        # 兼容无 openssl 的微型宿主机系统
        cat /dev/urandom | tr -dc 'a-zA-Z0-9' | fold -w 32 | head -n 1
    fi
}

# 2. 导入与解析 .env 环境变量
load_env() {
    if [ -f "$ENV_FILE" ]; then
        # 过滤掉开头为 # 的注释，优雅利用 export 加载
        export $(grep -v '^#' "$ENV_FILE" | xargs)
    fi
}

# 3. 数据静默落笔至 .env 文件
save_env_var() {
    local key=$1
    local value=$2
    touch "$ENV_FILE"
    if grep -q "^$key=" "$ENV_FILE"; then
        # 处理 Linux/Mac 平台下不同的 sed 操作语法兼容
        if [ "$(uname)" = "Darwin" ]; then
            sed -i "" "s|^$key=.*|$key=$value|" "$ENV_FILE"
        else
            sed -i "s|^$key=.*|$key=$value|" "$ENV_FILE"
        fi
    else
        echo "$key=$value" >> "$ENV_FILE"
    fi
}

# 4. 初始化默认配置模板并写入当前绝对路径下
generate_default_env() {
    if [ ! -f "$ENV_FILE" ]; then
        echo -e "${YELLOW}未检测到现有环境配置，正在同级目录下自动定制专属 .env 配置文件...${NC}"
        local rand_enc=$(generate_random_secret)
        local rand_jwt=$(generate_random_secret)
        cat <<EOF > "$ENV_FILE"
# =========================================================================
# Docker 容器底层原生装载之系统配置项文件 (.env)
# =========================================================================
NODE_ENV=production
APP_PORT=3000
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
        echo -e "${GREEN}✓ .env 新配置文件生成成功！服务端口缺省值 ${YELLOW}3000${GREEN}，加解密密钥均自动完成高安全度动态随机设定。${NC}"
        sleep 1
    fi
}

# 获取磁盘可用大小及 40% 剩余空间算力指导
get_disk_free() {
    df -h "$SCRIPT_DIR" | awk 'NR==2 {print $4}'
}

get_recommended_storage() {
    local available_kb=$(df -k "$SCRIPT_DIR" | awk 'NR==2 {print $4}')
    local available_gb=$((available_kb / 1024 / 1024))
    local recommended=$((available_gb * 4 / 10))
    if [ "$recommended" -lt 1 ]; then recommended=1; fi
    echo $recommended
}

# =========================================================================
# 菜单 1：项目配置
# =========================================================================
project_config() {
    # 强制预加载/预生成 .env 供用户交互直接读取
    generate_default_env
    while true; do
        load_env
        clear
        echo -e "${BLUE}====================================================="
        echo -e "         🐳 File Express 项目中控配置细节            "
        echo -e "=====================================================${NC}"
        echo -e "配置文件地址: ${YELLOW}$ENV_FILE${NC}"
        echo -e "-----------------------------------------------------"
        echo -e "1. 应用展示名称  : ${GREEN}${APP_NAME:-"File Express"}${NC}"
        echo -e "2. 页面副标题设定 : ${GREEN}${APP_SUBTITLE:-"极简、安全、临时的文件传输中心"}${NC}"
        
        local current_quota_mb=${MAX_TOTAL_STORAGE_MB:-1024}
        local current_quota_gb=$(awk "BEGIN {printf \"%.1f\", $current_quota_mb / 1024}")
        echo -e "3. 总存储空间配额 : ${GREEN}${current_quota_gb} GB${NC} (系统剩余: $(get_disk_free))"
        
        echo -e "4. 单附件大小上限 : ${GREEN}${MAX_SINGLE_FILE_SIZE_MB:-10} MB${NC}"
        echo -e "5. ZIP 包体积上限 : ${GREEN}${MAX_ZIP_PAYLOAD_SIZE_MB:-50} MB${NC}"
        echo -e "6. 自定义映射端口 : ${GREEN}${APP_PORT:-3000}${NC} (宿主机直接访问端口)"
        echo -e "7. 文件长效保存期 : ${GREEN}${MAX_STORAGE_HOURS:-24} 小时${NC}"
        echo -e "8. 文件提取上限频 : ${GREEN}${MAX_DOWNLOADS:-100} 次${NC}"
        echo -e "9. 核心加解密密钥 : ${YELLOW}${STORAGE_ENCRYPTION_KEY:-"未安全预装"}${NC}"
        echo -e "10. JWT 授权金钥  : ${YELLOW}${JWT_SECRET:-"使用默认"}${NC}"
        echo -e "-----------------------------------------------------"
        echo -e "s. 一键确定生效并返回 | q. 放弃修改不保存返回"
        echo -e "-----------------------------------------------------"
        echo -e "${YELLOW}提示: 此配置直接写入本地绝对路径环境变量以防丢失，并在下次启动或重启时彻底生效。${NC}"
        echo -e "-----------------------------------------------------"
        
        read -p "请输入欲修改的配置项编号 (1-10, s/q): " cfg_choice
        case $cfg_choice in
            1)
                read -p "请输入应用前台大标题: " input_val
                [ -n "$input_val" ] && save_env_var "APP_NAME" "$input_val"
                ;;
            2)
                read -p "请输入前台说明副标题: " input_val
                [ -n "$input_val" ] && save_env_var "APP_SUBTITLE" "$input_val"
                ;;
            3)
                local rec_gb=$(get_recommended_storage)
                echo -e "当前路径磁盘空间可利用约 $(get_disk_free)。"
                read -p "请输入总限额数值 (单位: GB) [推荐配置为系统空闲之 40%: $rec_gb GB]: " input_val
                [ -z "$input_val" ] && input_val=$rec_gb
                local mb_val=$((input_val * 1024))
                save_env_var "MAX_TOTAL_STORAGE_MB" "$mb_val"
                ;;
            4)
                read -p "请输入单个上传附件大小限额 (单位: MB, 推荐 10): " input_val
                [ -n "$input_val" ] && save_env_var "MAX_SINGLE_FILE_SIZE_MB" "$input_val"
                ;;
            5)
                read -p "请输入整包 ZIP 大小限额 (单位: MB, 推荐 50): " input_val
                [ -n "$input_val" ] && save_env_var "MAX_ZIP_PAYLOAD_SIZE_MB" "$input_val"
                ;;
            6)
                read -p "请输入宿主机映射暴露端口 (推荐 3000 或 80): " input_val
                if [ -n "$input_val" ]; then
                    save_env_var "APP_PORT" "$input_val"
                    echo -e "\n${YELLOW}⚠ 端口已更新为 $input_val，必须重建容器才能生效。${NC}"
                    read -p "是否立即重建容器以应用新端口？(Y/n): " restart_choice
                    if [ "$restart_choice" != "n" ] && [ "$restart_choice" != "N" ]; then
                        load_env
                        local _compose_cmd=$(get_compose_command)
                        $_compose_cmd down 2>/dev/null || true
                        $_compose_cmd up -d
                        echo -e "${GREEN}✓ 容器已重建并使用新端口 ${APP_PORT:-$input_val}${NC}"
                        refresh_public_ip
                        echo ""
                        show_access_urls
                        sleep 2
                    fi
                fi
                ;;
            7)
                read -p "请输入文件默认销毁时长 (单位: 小时, 默认 24): " input_val
                [ -n "$input_val" ] && save_env_var "MAX_STORAGE_HOURS" "$input_val"
                ;;
            8)
                read -p "请输入单个提取码最大提取失效上限 (默认 100): " input_val
                [ -n "$input_val" ] && save_env_var "MAX_DOWNLOADS" "$input_val"
                ;;
            9)
                read -p "请输入强加解密数据密钥 (推荐 32 位强随机): " input_val
                [ -n "$input_val" ] && save_env_var "STORAGE_ENCRYPTION_KEY" "$input_val"
                ;;
            10)
                read -p "请输入 JWT 签名鉴权保护密钥: " input_val
                [ -n "$input_val" ] && save_env_var "JWT_SECRET" "$input_val"
                ;;
            s|q) break ;;
            *) echo -e "${RED}❌ 无效编号，请重新输入 1 至 10 之间的服务编号。${NC}" ; sleep 1.5 ;;
        esac
    done
}

# =========================================================================
# 帮助工具：检测并一键自愈安装 Docker 与 Docker Compose 运行宿主环境
# =========================================================================
ensure_docker_env() {
    if ! command -v docker &>/dev/null; then
        echo -e "${YELLOW}发现当前系统中未部署 Docker 引擎服务，正在全力自愈自动下载配置中...${NC}"
        if curl -fsSL https://get.docker.com | bash -s docker --mirror Aliyun; then
            echo -e "${GREEN}✓ Docker 引擎一键极速安装挂载就绪！${NC}"
        else
            echo -e "${RED}❌ 自动安装 Docker 失败。请参考 deployment.md 手动安装 Docker 环境后再试。${NC}"
            exit 1
        fi
    fi

    # 兼容低版本的 docker-compose 独立可执行程序和现代的 docker compose CLI 插件
    if ! docker compose version &>/dev/null && ! command -v docker-compose &>/dev/null; then
        echo -e "${YELLOW}发现未安装 Docker Compose 插件，正在尝试自动极速一键自愈安装...${NC}"
        sudo curl -SL "https://github.com/docker/compose/releases/latest/download/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
        sudo chmod +x /usr/local/bin/docker-compose
        sudo ln -sf /usr/local/bin/docker-compose /usr/bin/docker-compose
        echo -e "${GREEN}✓ Docker Compose CLI 自动就绪成功。${NC}"
    fi

    # 验证 Docker daemon 是否真正在运行
    if ! docker info &>/dev/null; then
        echo -e "${YELLOW}Docker daemon 未运行，尝试启动...${NC}"
        if command -v systemctl &>/dev/null; then
            sudo systemctl start docker 2>/dev/null || true
        elif command -v service &>/dev/null; then
            sudo service docker start 2>/dev/null || true
        fi
        sleep 2
        if ! docker info &>/dev/null; then
            echo -e "${RED}❌ Docker daemon 无法启动。请手动执行 'sudo systemctl start docker' 后重试。${NC}"
            exit 1
        fi
    fi
    echo -e "${GREEN}✓ Docker 引擎运行正常。${NC}"
}

get_compose_command() {
    if docker compose version &>/dev/null; then
        echo "docker compose"
    else
        echo "docker-compose"
    fi
}

# =========================================================================
# 菜单 2：全新安装部署/升级版本
# =========================================================================
deploy_version() {
    clear
    echo -e "${BLUE}====================================================="
    echo -e "       ⚡ 全新安装部署/升级更新 File Express 容器       "
    echo -e "=====================================================${NC}"
    
    # 极速环境自愈检测
    ensure_docker_env
    
    # 静默自愈安全环境机制：确保 .env 文件一定在此同级项目目录下以默认配置项完美落地
    generate_default_env
    load_env

    # 确定路径安全性自愈，防止容器卷路径创建由于 root 运行导致不可读写，自动提前置备
    mkdir -p "$STORAGE_DIR"
    if [ ! -f "$DB_FILE" ]; then
        echo '{"files": {}}' > "$DB_FILE"
    fi
    chmod 777 "$STORAGE_DIR" "$DB_FILE" 2>/dev/null || true

    echo -e "请选择安装部署的镜像类型:"
    echo -e "1) ${GREEN}手动拉取远程 GHCR 预编译高纯生产镜像 (极力推荐)${NC}"
    echo -e "2) ${YELLOW}基于本地当前源码，现场编译成新镜像容器部署 (开箱即用)${NC}"
    read -p "请做出您的选择 (1 或 2，默认为 1): " deploy_choice
    [ -z "$deploy_choice" ] && deploy_choice=1

    local compose_cmd=$(get_compose_command)

    if [ "$deploy_choice" -eq 1 ]; then
        echo -e "\n${BLUE}>>> 正在拉取线上发布镜像...${NC}"
        local default_owner="alivedou"
        local default_repo="fileexpress"
        local default_tag="latest"

        # 尝试自动检测本地 Git 仓库提取仓库归属账号
        if [ -d "$SCRIPT_DIR/.git" ] && command -v git &> /dev/null; then
            local remote_url=$(git config --get remote.origin.url)
            if [[ $remote_url =~ github.com[:/]([^/]+)/([^.]+)(\.git)? ]]; then
                default_owner="${BASH_REMATCH[1]}"
                default_repo="${BASH_REMATCH[2]}"
            fi
        fi
        
        # 强制将名称转换为小写以防 Docker registry 不满足大写的安全协议
        default_owner=$(echo "$default_owner" | tr '[:upper:]' '[:lower:]')
        default_repo=$(echo "$default_repo" | tr '[:upper:]' '[:lower:]')

        read -p "请输入镜像发布用户/组织账号 [默认: $default_owner]: " user_input
        [ -z "$user_input" ] && user_input=$default_owner
        read -p "请输入镜像包容器名称 [默认: $default_repo]: " repo_input
        [ -z "$repo_input" ] && repo_input=$default_repo
        read -p "请输入欲拉取的版本版本Tag [默认: latest]: " tag_input
        [ -z "$tag_input" ] && tag_input=$default_tag

        local target_image="ghcr.io/${user_input}/${repo_input}:${tag_input}"
        echo -e "${YELLOW}正在强力呼叫网络，拉取最新预制生产镜像: $target_image...${NC}"
        
        if docker pull "$target_image"; then
            echo -e "${GREEN}✓ 镜像拉取完美完成！正在更新您的 docker-compose.yml 服务对应声明...${NC}"
            if [ -f "$SCRIPT_DIR/docker-compose.yml" ]; then
                # 将 build: . 替换为 image: ghcr.io/xxx，防止 Docker Compose 仍然触发本地编译
                # 同时也移除可能残留的旧 image 行
                if [ "$(uname)" = "Darwin" ]; then
                    sed -i "" "s|^\s*build:.*|    image: $target_image|" "$SCRIPT_DIR/docker-compose.yml"
                    sed -i "" "s|^\s*image:.*|    image: $target_image|" "$SCRIPT_DIR/docker-compose.yml"
                else
                    sed -i "s|^\s*build:.*|    image: $target_image|" "$SCRIPT_DIR/docker-compose.yml"
                    sed -i "s|^\s*image:.*|    image: $target_image|" "$SCRIPT_DIR/docker-compose.yml"
                fi
            fi
            
            # 先全量拆除旧容器及网络，确保端口映射使用最新 .env 配置
            echo -e "${YELLOW}正在拆除旧容器并全新拉起服务...${NC}"
            $compose_cmd down 2>/dev/null || true
            if ! $compose_cmd up -d; then
                echo -e "${RED}❌ 容器启动失败！请检查日志: $compose_cmd logs${NC}"
                sleep 3
                return
            fi
            echo -e "\n${GREEN}★ 部署成功已在线激活上线！${NC}"
            refresh_public_ip
            echo ""
            show_access_urls
        else
            echo -e "${RED}❌ 镜像拉取失败。${NC}"
            echo -e "可能原因："
            echo -e "  1. 镜像尚未发布（需先在 GitHub Actions 手动触发 docker-publish 工作流）"
            echo -e "  2. GitHub Container Registry 在中国大陆解析慢/不可达"
            echo -e "  3. 镜像 tag '${tag_input}' 不存在，尝试用 'latest'"
            echo -e "\n${YELLOW}建议：选 '选项2' 用本地源码直接打包编译，无需网络拉取镜像。${NC}"
            sleep 2
        fi
    else
        # 本地热打包流
        echo -e "\n${BLUE}>>> 正在启动 Docker 引擎基于当前目录下源码本地化编译打桩包...${NC}"
        if [ ! -f "$SCRIPT_DIR/Dockerfile" ]; then
            echo -e "${RED}❌ 致命错误：当前目录下未感应到 Dockerfile，无法启动直打，过程强退！${NC}"
            sleep 2
            return
        fi
        # 本地编译也需要先把 build 行还原（如果之前被 GHCR 模式替换过）
        if ! grep -q "^\s*build:" "$SCRIPT_DIR/docker-compose.yml"; then
            if [ "$(uname)" = "Darwin" ]; then
                sed -i "" "s|^\s*image:.*|    build: .|" "$SCRIPT_DIR/docker-compose.yml"
            else
                sed -i "s|^\s*image:.*|    build: .|" "$SCRIPT_DIR/docker-compose.yml"
            fi
        fi
        if ! $compose_cmd up -d --build; then
            echo -e "${RED}❌ 本地编译/启动失败！请检查上方错误信息。常见原因：端口被占用、磁盘空间不足。${NC}"
            echo -e "查看完整日志: $compose_cmd logs"
            sleep 3
            return
        fi
        echo -e "\n${GREEN}★ 本地编译及冷启动成功！${NC}"
        refresh_public_ip
        echo ""
        show_access_urls
    fi
    read -p "按 [Enter] 键一键返回控制台主菜单..." dummy
}

# =========================================================================
# 菜单 3：检查容器运行状态
# =========================================================================
check_status() {
    clear
    echo -e "${BLUE}====================================================="
    echo -e "         🔍 正在实时检索当前项目容器物理部署与网卡状况 "
    echo -e "=====================================================${NC}"
    local compose_cmd=$(get_compose_command)
    
    if $compose_cmd ps &>/dev/null; then
        $compose_cmd ps
    else
        # 兜底查询原生容器列表
        docker ps -a --filter "name=file-express"
    fi
    echo -e "-----------------------------------------------------"
    
    # 动态分析 IP 输出，给予极其高水准的温馨部署链接呈现
    local local_ip=$(hostname -I | awk '{print $1}')
    [ -z "$local_ip" ] && local_ip="127.0.0.1"
    load_env
    local port=${APP_PORT:-3000}

    echo -e "应用内网/虚拟机映射地址  : ${GREEN}http://${local_ip}:${port}${NC}"
    if command -v curl &>/dev/null; then
        local public_ip=$(curl -s --max-time 1.2 ifconfig.me || curl -s --max-time 1.2 ip.sb)
        if [ -n "$public_ip" ]; then
            echo -e "服务器外部推荐访问地址  : ${GREEN}http://${public_ip}:${port}${NC}"
        fi
    fi
    if [ "$port" != "80" ] && [ "$port" != "443" ]; then
        echo -e "${YELLOW}📌 防火墙提示：请确保云服务器安全组/防火墙已放行端口 ${port}${NC}"
    fi
    echo -e "-----------------------------------------------------"
    read -p "输入 [Enter] 键立刻带您重回主菜单..." dummy
}

# =========================================================================
# 菜单 4：查看容器实时运行日志
# =========================================================================
view_logs() {
    clear
    echo -e "${BLUE}====================================================="
    echo -e "         📋 正在切入容器流式控制日志 (Ctrl+C 退出)   "
    echo -e "=====================================================${NC}"
    local compose_cmd=$(get_compose_command)
    $compose_cmd logs -f --tail=100
}

# =========================================================================
# 菜单 5：【核心重点任务】数据初始化 (重置)
# =========================================================================
init_database_new() {
    clear
    echo -e "${RED}====================================================="
    echo -e "             🚨 【高级危险】核心数据彻底清空与重置     "
    echo -e "=====================================================${NC}"
    echo -e "⚠️  该功能专属于 Docker 数据挂载卷自洁，不可撤销！"
    echo -e "执行后，系统将彻底擦除并释放："
    echo -e "1) ${YELLOW}宿主机上挂载已上传的全部物理体积文件${NC} ($STORAGE_DIR/*)"
    echo -e "2) ${YELLOW}本地元数据库中的所有提取配对及传输痕迹${NC} ($DB_FILE)"
    echo -e "-----------------------------------------------------"
    echo -e "${GREEN}安全保活设计：您的项目端口配置、各项限额与加密密钥等环境配置文件 (.env) 将被完整保留！${NC}"
    echo -e "-----------------------------------------------------"
    
    # 第一层安全拦截
    read -p "⚠️  您确定要彻底清空上述全部数据，使快递柜一键重归净空状态吗？(y/N): " choice1
    if [ "$choice1" != "y" ] && [ "$choice1" != "Y" ]; then
        echo -e "${BLUE}>>> 保持现状，重置操作因用户取消而宣告中止。${NC}"
        sleep 1.5
        return
    fi

    # 第二层极其专业的高级双重拦截
    echo -e "\n${RED}👿 !!危险确认警告!!${NC}"
    echo -e "存储在 $STORAGE_DIR 中的千万数据和挂载物将在接下来灰飞烟灭！"
    read -p "【二次阻拦验证】请输入大写字母 CONFIRM 确认重置: " choice2
    if [ "$choice2" != "CONFIRM" ]; then
        echo -e "${BLUE}>>> 安全拦截起效，验证码输入错误或放弃输入。重做完毕，返回主页。${NC}"
        sleep 1.5
        return
    fi

    # 执行流程
    echo -e "\n${YELLOW}正在优雅中断并解除容器与文件的占锁定依赖...${NC}"
    local compose_cmd=$(get_compose_command)
    
    # 停止容器以防止在文件被清除时，容器内 Node 程序由于文件被抢占引发致命底层错误
    $compose_cmd stop &>/dev/null || true

    echo -e "${YELLOW}正在强力格式化清除物理挂载路径 [local_storage]...${NC}"
    rm -rf "$STORAGE_DIR"/*
    mkdir -p "$STORAGE_DIR"

    echo -e "${YELLOW}正在覆写本地元数据库配置 [local_db.json] 为洁净初始 JSON 格式...${NC}"
    echo '{"files": {}}' > "$DB_FILE"

    echo -e "${YELLOW}强行重置并刷新挂载点在宿主机文件层级的可读写 777 权限锁，避免容器权限阻塞...${NC}"
    chmod 777 "$STORAGE_DIR" "$DB_FILE" 2>/dev/null || true

    echo -e "${YELLOW}正在重新复活拉起应用容器，执行环境装载过程...${NC}"
    $compose_cmd start &>/dev/null || $compose_cmd up -d &>/dev/null

    echo -e "\n${GREEN}✓ 数据彻底初始化重装完美完工！${NC}"
    echo -e "宿主机保底存储目录已净化，并以极其规范安全的方式成功挂载回归到正在热运行的 Docker 微服务实例中。"
    echo -e "-----------------------------------------------------"
    read -p "输入 [Enter] 键安全返回主面板..." dummy
}

# =========================================================================
# 菜单 6：彻底卸载安装与全数据清理
# =========================================================================
uninstall_all() {
    clear
    echo -e "${RED}====================================================="
    echo -e "             🌋 【自毁核心】彻底离线卸载此项目服务    "
    echo -e "=====================================================${NC}"
    echo -e "⚠️  该脚本将全自动停服、清理容器并且自毁硬盘上关于该快递柜的全部蛛丝马迹："
    echo -e "1) 彻底停止并销毁当前项目容器实态（包含网络与虚拟数据卷）"
    echo -e "2) 自清洗删除本地全部缓存的 ghcr.io 线上大镜像以及直打打包体积镜像"
    echo -e "3) 强力抹除本地的物理暂存区文件、密码库、所有的 .env 配置文件"
    echo -e "-----------------------------------------------------"
    read -p "⚠️  输入大写 UNINSTALL 确认彻底卸载并自毁全部痕迹: " un_confirm
    if [ "$un_confirm" != "UNINSTALL" ]; then
        echo -e "${BLUE}>>> 取消卸载操作，全部服务和本地保全数据原封不动封存。${NC}"
        sleep 1.5
        return
    fi

    echo -e "\n${YELLOW}正在停服、移出全部容器实体...${NC}"
    local compose_cmd=$(get_compose_command)
    $compose_cmd down --rmi all --volumes --remove-orphans 2>/dev/null || true

    echo -e "${YELLOW}正在重清洗并抹除全部持久层配置，包含密钥与本地文件袋...${NC}"
    rm -rf "$STORAGE_DIR"
    rm -f "$DB_FILE"
    rm -f "$ENV_FILE"

    echo -e "\n${RED}✓ 整个文件快递柜服务已完全从本机连根拔起卸载成功，无任何持久残留。${NC}"
    sleep 3
    exit 0
}

# =========================================================================
# 获取并展示当前公网/内网访问地址（公网 IP 带缓存，避免每次 curl 卡顿）
# =========================================================================
CACHE_IP_FILE="$SCRIPT_DIR/.external_ip"

show_access_urls() {
    load_env
    local port=${APP_PORT:-3000}
    local local_ip=$(hostname -I | awk '{print $1}')
    [ -z "$local_ip" ] && local_ip="127.0.0.1"

    echo -e "应用内网访问地址  : ${GREEN}http://${local_ip}:${port}${NC}"

    # 公网 IP 首次获取后缓存，避免主菜单每次刷新都阻塞
    if [ -f "$CACHE_IP_FILE" ]; then
        local public_ip=$(cat "$CACHE_IP_FILE")
        echo -e "应用公网访问地址  : ${GREEN}http://${public_ip}:${port}${NC}"
    elif command -v curl &>/dev/null; then
        local public_ip=$(curl -s --max-time 1.5 ifconfig.me || curl -s --max-time 1.5 ip.sb)
        if [ -n "$public_ip" ]; then
            echo "$public_ip" > "$CACHE_IP_FILE"
            echo -e "应用公网访问地址  : ${GREEN}http://${public_ip}:${port}${NC}"
        fi
    fi

    if [ "$port" != "80" ] && [ "$port" != "443" ]; then
        echo -e "${YELLOW}📌 如无法访问，请检查云服务器安全组/防火墙是否放行端口 ${port}${NC}"
    fi
}

# 调用此函数刷新公网 IP 缓存（部署成功后必须刷新）
refresh_public_ip() {
    if command -v curl &>/dev/null; then
        local public_ip=$(curl -s --max-time 1.5 ifconfig.me || curl -s --max-time 1.5 ip.sb)
        if [ -n "$public_ip" ]; then
            echo "$public_ip" > "$CACHE_IP_FILE"
        fi
    fi
}

# =========================================================================
# 全新统一中控交互主循环（纯化专属 Docker 管理板）
# =========================================================================
while true; do
    clear
    echo -e "${GREEN}====================================================="
    echo -e "      🐳 File Express 文件传输快递柜 Docker 运维控制台 "
    echo -e "=====================================================${NC}"
    echo -e "当前执行根路径: ${YELLOW}$SCRIPT_DIR${NC}"
    echo -e "-----------------------------------------------------"
    show_access_urls
    echo -e "-----------------------------------------------------"
    echo -e "1. ⚙️  项目配置"
    echo -e "2. ⚡ 安装部署/升级"
    echo -e "3. 🔍 运行状态"
    echo -e "4. 📋 实时日志"
    echo -e "5. 🧹 数据重置"
    echo -e "6. ❌ 彻底卸载"
    echo -e "7. 🚪 退出"
    echo -e "-----------------------------------------------------"
    read -p "您想要执行的控制台指令是 (1-7): " main_choice

    case $main_choice in
        1) project_config ;;
        2) deploy_version ;;
        3) check_status ;;
        4) view_logs ;;
        5) init_database_new ;;
        6) uninstall_all ;;
        7) echo -e "\n${BLUE}正在退出 Docker 终端运维中控，感谢您的使用，祝生活愉快！再见。${NC}" ; exit 0 ;;
        *) echo -e "${RED}❌ 无效选项，请输入正确的数字进行对应服务器子控制。${NC}" ; sleep 1.5 ;;
    esac
done
