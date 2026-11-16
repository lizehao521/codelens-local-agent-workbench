#!/usr/bin/env python3
"""
exp18c 回归迭代：把「方案不可执行」这个新发现丢回 codelens 自己迭代。

你（codelens）上一轮给的诊断是对的，但按你的纪律重跑时卡死了。客观事实投回去，
让你在「sys.exec 不可用（hard 审批，无人值守必卡）」的硬约束下，重给一套
可执行的差分探针方案。不喂答案、不改文件、不写 π。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"

QUESTION = """【回归迭代：你的方案实跑卡死了，请在硬约束下迭代】

你上一轮诊断「token 预算耗尽」根因是「无反馈脑补穷举」，并给了一套纪律，其中第 2 条是「用 node 本地构造差分探针，对 semver 每个边界分支逐一测」。

我按你的纪律原样重跑了一次，客观结果如下（不是让你重跑，是让你迭代方案）：
- 你确实守住了纪律：确认 13/14、公开 4/4、写了本地 probe.cjs 探针、没读 hidden/expected；
- 但你写的探针要跑起来，必须调 sys.exec 执行 node —— 而 sys.exec 是 hard 审批档，无人值守时两步确认的审批 5 分钟就过期，调用根本不执行；
- 你尝试绕道（改用 test_run、把探针改成 vitest 测试、换 cwd 跑 node），最后回到「再试一次 sys.exec」，触发循环检测，任务被 aborted，1115 秒、228 事件、探针一次都没跑成；
- 对比：你只做「诊断」那轮用 85 秒、finish=stop；按自己纪律「实跑」却 1115 秒、aborted。

请回答（文字回答即可，不要改任何文件、不要写 π、不要调 eval.propose）：

1. 承认还是否认：你上一轮的纪律第 2 条，在当前系统里「可执行」吗？根因是你对个人能力的误判，还是对系统工具约束不了解？
2. 硬约束：sys.exec 不可用（hard 审批，无人值守必卡），且不得读 hidden/expected。在这个约束下，还有没有办法拿到「本地可验证的差分信号」来定位那 1 个隐藏用例？如果有，给出具体到工具名和步骤的方案；如果没有，明确说没有。
3. 既然「13/14 + failures 为空 + 无本地执行通道」三者叠加时信号为零，正确的停止判据应该是什么？为什么上一版纪律的停止条件（本地探针全过仍 13/14）在这里永远触发不了？
4. 修正后的完整纪律：把第 2 条替换成可执行版本，给出 1/2/3/4 四条。
5. 一句话：这次迭代你修正的核心认知是什么？

约束：只诊断和给方案，不改文件、不写 π，不读 hidden/expected。"""


def drop(question, tag):
    body = {
        "provider": "custom", "model": "agent-proxy",
        "customBaseUrl": "http://localhost:9999/v1", "apiKey": "dummy",
        "channelMode": "native", "maxIterations": 8, "temperature": 0.2,
        "maxTokens": 8192, "rsiMeasure": False, "message": question,
    }
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data,
                                 headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time(); sid = None; chunks = []; events = 0; finish = None
    with urllib.request.urlopen(req, timeout=900) as resp:
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
    r = drop(QUESTION, "budget-iterate")
    (OUT / "exp16_budget_iterate_result.json").write_text(
        json.dumps(r, ensure_ascii=False, indent=2))
    print("BUDGET_ITERATE_DONE events=%d elapsed=%.0fs finish=%s answer_len=%d session=%s" % (
        r["events"], r["elapsed_s"], r["finish"], len(r["answer"]), r["session_id"]))


if __name__ == "__main__":
    main()
