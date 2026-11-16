#!/usr/bin/env python3
"""
exp18 独立诊断投放：把「token 预算耗尽」作为独立问题丢给 codelens 自己解。

边界（沿用 blind_rsi 立身之本）：
  1. 只投客观数据 + 原始自述，不喂我的结论（不说"你在臆测"）；
  2. 独立 session，只读不写：不改文件、不写 π、不调 eval.propose；
  3. 落盘脱敏，模型回答原文照录；
  4. 与 audit/fix/gap/debate 各任务互不污染。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"

# 从上一轮产出里取原始自述作为证据（原文照录，不加工）
SRC = json.loads((OUT / "exp16_gap_pi_result.json").read_text())
ROUND2_TEXT = SRC["round2"]["text"]

QUESTION = """【独立诊断任务，与你的主线无关，答完即止】

背景：一个与你同构的 codelens agent 刚跑完一轮「自我改进闭环」，目标：把自己造的 semver_compare 判据修到 14/14 满分。客观数据：
- 总耗时 793 秒，604 个事件，token 预算 256000 全部耗尽，finishReason = budget_exhausted
- 进度：从 6/14 提升到 13/14，最后 1 个隐藏用例始终没攻下
- 隐藏用例的 failures 数组为空（服务端不回显详情）

它的最后一段自述原文附在下面。请你诊断「为什么 token 会耗尽，以及如何才能不耗尽就收敛」，逐条回答：

1. 根因判定：这是「预算绝对值太小」还是「信息获取策略低效」？给判据——如果换成 512000 token，同样的策略能收敛吗？为什么？
2. 从自述里指出至少 2 处 token 花得最不值的地方，引用原文片段说明它当时在信息不足时做了什么。
3. 给一套「预算内收敛」的工具使用纪律：面对「隐藏用例不回显、failures 为空」，应该如何定位最后 1 个用例？按什么顺序调什么工具？什么条件下应判定「超出可解范围」并停止，而不是继续烧 token？
4. 投放参数是 maxIterations=20 / maxTokens=8192（每次输出上限）。若要重跑，你会怎么调这两个值？还是问题根本不在参数？
5. 一句话结论：这轮预算耗尽，最该改的是什么？

约束：不要修改任何文件、不要写 π、不要调 eval.propose。只诊断、只给方案。你的文字回答就是最终产出。

====== 该 agent 的自述原文（证据，勿改） ======
""" + ROUND2_TEXT


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
            "events": events, "finish": finish, "claim_len": len(ROUND2_TEXT),
            "answer": "".join(chunks)}


def main():
    r = drop(QUESTION, "budget-diagnosis")
    out = {"question_len": len(QUESTION), **r}
    (OUT / "exp16_budget_result.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2))
    print("BUDGET_DROP_DONE events=%d elapsed=%.0fs finish=%s answer_len=%d session=%s" % (
        r["events"], r["elapsed_s"], r["finish"], len(r["answer"]), r["session_id"]))


if __name__ == "__main__":
    main()
