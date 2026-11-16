#!/usr/bin/env python3
"""
exp18b 闭环验证：让 codelens 用自己刚定的「收敛纪律」重跑 semver_compare。

干净验证：投放参数与上次相同（maxIterations=20 / maxTokens=8192），
只换策略（它自己第 3 条），看能否在 256000 预算内收敛。

边界：不得读 hidden/expected；不改 src/ 与受保护 eval 套件；
只改 workspace/eval/semver_compare/impl.cjs（沙箱运行时副本）。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"

QUESTION = """【执行验证：用你自己刚定的纪律重跑一次，证明它有效】

你在上一轮诊断里判定：semver_compare 预算耗尽的根因是「无反馈的脑补穷举」，并给出收敛纪律。现在请你亲自按这套纪律重跑一次，验证它真的有效。

当前状态：
- 套件 semver_compare：13/14（剩 1 个隐藏用例，failures 数组不回显）
- 实现文件：server/workspace/eval/semver_compare/impl.cjs（你上一轮写到 13/14 的版本）
- 总 token 预算 256000（contextWindow 128000 × factor 2），本轮你要在预算内收敛

你自己的纪律（必须遵守）：
1. 先确认公开用例 100% 通过——这是唯一有确定反馈的部分；
2. 用 node 本地构造差分探针：对 semver 规范的每个边界分支（前导零、build 元数据、预发布数字/字母标识符、长度、空段）逐一构造输入，看实现输出是否符合规范，靠本地信号定位，不靠脑补猜；
3. eval_run 只传 suite: "semver_compare"，绝不跑全量 166 用例；
4. 设停止条件：当本地探针覆盖规范所有分支且全部正确、但服务端仍 13/14 时，判定「缺口在隐藏用例的非规范边界、超出可解范围」，明确停止，不再烧 token 猜。

报告（文字回答，不要改其他文件）：
- 最终读数（x/14）
- 迭代次数、大致 token 消耗、finishReason 是 stop 还是 budget_exhausted
- 按你自己的标准：这套纪律奏效了吗？哪里还不够？

硬约束：不得读 hidden/expected；不改 src/ 与受保护 eval 套件；只改 server/workspace/eval/semver_compare/impl.cjs。"""


def drop(question, tag):
    body = {
        "provider": "custom", "model": "agent-proxy",
        "customBaseUrl": "http://localhost:9999/v1", "apiKey": "dummy",
        "channelMode": "native", "maxIterations": 20, "temperature": 0.2,
        "maxTokens": 8192, "rsiMeasure": False, "message": question,
    }
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time(); sid = None; chunks = []; events = 0; finish = None
    with urllib.request.urlopen(req, timeout=1400) as resp:
        for raw in resp:
            line = raw.decode(errors="replace").rstrip("\n")
            if not line.strip().startswith("data:"):
                continue
            try:
                ev = json.loads(line.strip()[5:].strip())
            except Exception:
                continue
            events += 1
            if ev.get("sessionId"):
                sid = ev["sessionId"]
            for k in ("text", "delta", "content"):
                v = ev.get(k)
                if isinstance(v, str) and v:
                    chunks.append(v)
            if ev.get("finishReason"):
                finish = ev["finishReason"]
    return {"tag": tag, "session_id": sid, "elapsed_s": round(time.time() - t0, 1),
            "events": events, "finish": finish, "answer": "".join(chunks)}


def main():
    r = drop(QUESTION, "budget-validate")
    (OUT / "exp16_budget_validate_result.json").write_text(
        json.dumps(r, ensure_ascii=False, indent=2))
    print("BUDGET_VALIDATE_DONE events=%d elapsed=%.0fs finish=%s answer_len=%d session=%s" % (
        r["events"], r["elapsed_s"], r["finish"], len(r["answer"]), r["session_id"]))


if __name__ == "__main__":
    main()
