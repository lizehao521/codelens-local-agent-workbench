# 本地运行：CodeLens ← api-relay（同机两层）

本工程的 `server/.env` 已改为**经本机 api-relay 调用模型**（而不是直连厂商），用于演示「底座 + 工作台」的组合闭环：

```
浏览器 → CodeLens(:8080) → api-relay(:8787) → NVIDIA NIM(integrate.api.nvidia.com)
                                ↑ 计量/归因/限流/档位都在这一层
```

## 启动顺序

1. 先起底座（在 api-relay 工程目录：`C:\Users\Admin\Desktop\api-relay+落幕+v1.13.0+li1119489753@outlook.com\project`）：
   ```powershell
   pwsh -NoProfile -File scripts-local\start-relay.ps1
   ```
2. 再起本工程：
   ```powershell
   pwsh -NoProfile -File scripts\start-codelens-local.ps1
   ```
3. 浏览器打开 `http://127.0.0.1:8080`；底座面板 `http://127.0.0.1:8787/admin`

## 本工程 `.env` 的关键改动

| 键 | 值 | 作用 |
|---|---|---|
| `LLM_SERVER_API_KEY` | relay 的 `RELAY_KEY_PRO` | 试用通道用这把 key 调 relay（不再直连） |
| `TRIAL_MODE_ENABLED` | `true` | 开启试用通道 |
| `TRIAL_BASE_URL` | `http://127.0.0.1:8787/v1` | 指向同机 relay |
| `TRIAL_MODEL` | `minimaxai/minimax-m3.1-flash` | 实测 3s 内返回的非推理模型 |
| `RSI_BASE_URL` / `RSI_API_KEY` | relay 地址 / relay key | RSI 深判同样穿过底座，可计量 |
| `MODEL_SOURCE_URL` | `http://127.0.0.1:8787/v1/models` | 模型清单从 relay 同步 |
| `MODEL_SOURCE_ALLOW_INSECURE` / `_ALLOW_PRIVATE` | `true` | 允许 http + 回环（SSRF 默认会拦） |

原配置备份在同目录 `server/.env.bak-20261116-localrelay`，需要回滚直接覆盖回去。

## 验证

```powershell
Invoke-WebRequest http://127.0.0.1:8787/healthz   # 底座
Invoke-WebRequest http://127.0.0.1:8080/api/health
Invoke-WebRequest http://127.0.0.1:8080/api/v1/agent/trial-status   # trialUpstream.health.status 应为 ok
Invoke-WebRequest http://127.0.0.1:8787/v1/panel                    # 能看到 tokens / traces / 归因
```

## 注意

- 两个服务都只绑 `127.0.0.1`，局域网访问需显式改 `HOST`/`host` 并配置鉴权。
- 底座 `.relay.env` 与 OpenAI/NVIDIA 的 key **不要提交**；仓库已忽略 `.env` / `.relay.env`。
- 本机全局存在 `NODE_TLS_REJECT_UNAUTHORIZED=0`，启动脚本已仅对子进程恢复为 `1`。