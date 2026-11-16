#!/usr/bin/env python3
"""
exp18d 最终验证：用 codelens 第三轮迭代出的「静态只读审查」纪律实跑一次。

与 exp18b（卡在 sys.exec aborted）最大区别：方案已换成全只读工具，
不含任何 hard 审批工具。参数保持一致（maxIterations=20），只验证方案可执行性。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"
ANS = json.loads((OUT / "exp16_budget_iterate_result.json").read_text())["answer"]

QUESTION = """【最终验证：用你第三轮修正后的纪律实跑一次】

你在第三轮给出了修正后的纪律（先核实通道可用性、用 fs_read+code_search+text_diff 静态审查分支、每改一处跑一次 eval_run、停止判据不依赖 sys.exec）。现在按你自己这版纪律，实跑一次。

当前状态：semver_compare 13/14（1 隐藏用例，failures 不回显）；实现文件 server/workspace/eval/semver_compare/impl.cjs；总预算 256000。

严格遵守你第三轮自己写的 1/2/3/4 四条，尤其：
- 绝不调用 sys.exec（hard 审批，无人值守必卡，上轮就是死在这）；
- 差分靠静态只读审查，不靠跑代码；
- 每改一处跑一次 eval_run（只传 suite: semver_compare，不跑全量）；
- 命中你自己定义的停止判据就停，不要无限重试。

报告：最终读数 x/14、迭代与 token 消耗、finishReason、你这版纪律是否可执行（对比上一版卡死）。

硬约束：不读 hidden/expected；不改 src/ 与受保护 eval 套件；只改 server/workspace/eval/semver_compare/impl.cjs。

====== 你第三轮的纪律原文 ======
""" + ANS


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
    r = drop(QUESTION, "budget-final")
    (OUT / "exp16_budget_final_result.json").write_text(
        json.dumps(r, ensure_ascii=False, indent=2))
    print("BUDGET_FINAL_DONE events=%d elapsed=%.0fs finish=%s answer_len=%d session=%s" % (
        r["events"], r["elapsed_s"], r["finish"], len(r["answer"]), r["session_id"]))


if __name__ == "__main__":
    main()
