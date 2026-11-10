#!/usr/bin/env bash
# 启动 codelens-server + RSI L1 机械桥 + L2 深判（真实 API）
# 首次跑 seed 脚本注入演示数据（幂等，会清 session 重写）
set -euo pipefail

cd "$(dirname "$0")"

export LLM_SERVER_API_KEY='sk-relay-qYbr8zxWfqAENi8rMCKvNg4-C_OFymcS'
export DEEP_ASSESSOR_BASE_URL='http://1.92.92.200:8787/v1'
export DEEP_ASSESSOR_MODEL='deepseek-chat'
export DEEP_ASSESSOR_PROVIDER='custom'
export AGENT_DB_PATH='./data/codelens.db'

# 启动 server（终端 1）
node dist/app.js
