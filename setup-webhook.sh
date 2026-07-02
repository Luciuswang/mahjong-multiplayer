#!/bin/bash
# 🎣 GitHub Webhook 自动部署设置脚本

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🎣 设置 GitHub Webhook 自动部署..."
echo "================================"

# 1. 确保项目目录存在
cd /opt/mahjong-multiplayer

# 2. 开放 webhook 端口
echo -e "${YELLOW}[1/3] 开放防火墙端口 9000...${NC}"
ufw allow 9000
echo "y" | ufw enable || true

# 3. 启动 webhook 服务
echo -e "${YELLOW}[2/3] 启动 Webhook 服务...${NC}"
pm2 delete webhook 2>/dev/null || true
sudo fuser -k 9000/tcp 2>/dev/null || true
pm2 start webhook.js --name webhook --time
pm2 save

echo -e "${YELLOW}[3/3] 检查 Webhook 健康状态...${NC}"
sleep 1
curl -fsS http://127.0.0.1:9000/health >/dev/null

# 4. 获取服务器 IP
PUBLIC_IP=$(curl -s ifconfig.me || curl -s icanhazip.com || echo "你的服务器IP")

echo ""
echo "================================"
echo -e "${GREEN}✅ Webhook 服务已启动！${NC}"
echo "================================"
echo ""
echo "📍 Webhook URL: http://${PUBLIC_IP}:9000/webhook"
echo ""
echo "🔧 请在 GitHub 仓库设置中添加 Webhook："
echo "   1. 打开 https://github.com/Luciuswang/mahjong-multiplayer/settings/hooks"
echo "   2. 点击 'Add webhook'"
echo "   3. Payload URL: http://${PUBLIC_IP}:9000/webhook"
echo "   4. Content type: application/json"
echo "   5. Secret: (留空或设置自定义密钥)"
echo "   6. 选择 'Just the push event'"
echo "   7. 点击 'Add webhook'"
echo ""
echo "📋 管理命令："
echo "   pm2 logs webhook  - 查看日志"
echo "   pm2 restart webhook - 重启服务"
echo ""
