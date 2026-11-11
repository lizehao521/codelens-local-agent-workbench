#!/usr/bin/env bash
# 启动 codelens-server + RSI L1 机械桥 + L2 深判（真实 API）
# 首次跑 seed 脚本注入演示数据（幂等，会清 session 重写）
set -euo pipefail

cd "$(dirname "$0")"

# 凭证不在此导出：src/config/env.ts 会从 server/.env 加载 LLM_SERVER_API_KEY。
# 该文件已被 .gitignore 排除，Key 绝不写进源码 —— 源码会进 git。
export DEEP_ASSESSOR_BASE_URL='http://1.92.150.5:8787/v1'
export DEEP_ASSESSOR_MODEL='deepseek-chat'
export DEEP_ASSESSOR_PROVIDER='custom'
export AGENT_DB_PATH='./data/codelens.db'

# 启动 server（终端 1）
node dist/app.js
