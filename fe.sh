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
        echo -e "7. 外部访问URL: ${BLUE}${APP_URL:-"未设置 (运行后自动检测)"}${NC}"
        echo -e "8. 自定义端口: ${GREEN}${APP_PORT:-3000}${NC}"
        echo -e "----------------------------------------"
        echo -e "s. 保存并返回 | q. 直接返回"
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
                read -p "输入外部访问URL (如 http://domain.com): " input_val
                [ ! -z "$input_val" ] && save_env_var "APP_URL" "$input_val"
                ;;
            8)
                read -p "输入自定义运行端口 (默认 3000): " input_val
                [ -z "$input_val" ] && input_val=3000
                save_env_var "APP_PORT" "$input_val"
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
    
    # 尝试获取本机 IP
    local local_ip=$(hostname -I | awk '{print $1}')
    local port=${APP_PORT:-3000}
    
    echo -e "${BLUE}========================================"
    echo -e "      APPLICATION STARTUP SEQUENCE      "
    echo -e "=======================================${NC}"
    echo -e "本地网地址: ${GREEN}http://$local_ip:$port${NC}"
    if [ ! -z "$APP_URL" ]; then
        echo -e "配置访问址: ${GREEN}$APP_URL${NC}"
    fi
    echo -e "手机扫码或浏览器访问上方地址即可使用。"
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

# 主循环
while true; do
    clear
    echo -e "${BLUE}========================================"
    echo -e "    File Express 管理工具 (FE CLI)     "
    echo -e "=======================================${NC}"
    echo -e "1. ${GREEN}项目配置${NC} (环境变量与限额)"
    echo -e "2. ${YELLOW}数据库初始化${NC} (清空数据)"
    echo -e "3. ${BLUE}前台运行测试${NC} (Ctrl+C 退出)"
    echo -e "4. ${GREEN}后台稳定运行${NC} (静默挂载)"
    echo -e "5. ${RED}停止后台运行${NC} (终结进程)"
    echo -e "6. 退出菜单"
    echo -e "----------------------------------------"
    read -p "请选择 (1-6): " main_choice

    case $main_choice in
        1) project_config ;;
        2) init_database ;;
        3) run_app false ;;
        4) run_app true ;;
        5) stop_app_bg ;;
        6) echo "再见！" ; exit 0 ;;
        *) echo -e "${RED}无效选择 (1-6)${NC}" ; sleep 1 ;;
    esac
done
