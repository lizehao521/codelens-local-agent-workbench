#!/usr/bin/env python3
"""
exp16 辩论协同：让 codelens 扮演独立反方，质疑它自己刚产出的缺口/π 判断。

- 走独立 session（不续主任务 session），只读不写：不改 π、不改判据、不改文件。
- 辩题取自 gap_pi_iterate 的产出（模型自己的原话），我不预设结论。
- 旁账落 debate_result.json，与主任务账分开，互不污染。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"

def build_question(claim: str) -> str:
    return """你现在扮演「独立反方审计者」，不是刚才那个做事的自己。你的职责是质疑，不是维护先前结论。

下面是另一个 session（实质上也是你，但独立上下文）刚给出的判断原文：

===== 待辩观点 BEGIN =====
""" + claim + """
===== 待辩观点 END =====

请逐条反驳，只输出文本，不要调用工具、不要改任何文件或判据：
1. 这个观点里哪一句最可能错？给出具体的反例或论证，不要泛泛说"可能有问题"。
2. 它声称的"缺口"是真的能力缺口，还是测量口径/记分方式造成的假象？怎么区分？
3. 它建议的 π（策略阈值）调整方向，有没有副作用——比如会不会把某个判据变成恒绿/恒红，或诱发刷分？
4. 如果让你给这个观点打一个可信度分（0-10），你打几分？扣分点是什么？

边界：你只做辩论，结论落旁账；不写 policy、不改判据塔、不改任何文件。对观点不对人。"""

def main():
    result = json.loads((OUT / "exp16_gap_pi_result.json").read_text())
    # 取第二轮自述与策略建议作为辩题；若为空退到第一轮
    claim = (result.get("round2", {}).get("text") or "").strip()
    if not claim:
        claim = (result.get("round1", {}).get("text") or "").strip()
    claim = claim[:6000]  # 防预算撞顶

    body = {
        "provider": "custom", "model": "agent-proxy",
        "customBaseUrl": "http://localhost:9999/v1", "apiKey": "dummy",
        "channelMode": "native", "maxIterations": 5, "temperature": 0.3,
        "maxTokens": 8192, "rsiMeasure": False,
        "message": build_question(claim),
    }
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data, headers={"Content-Type": "application/json"}, method="POST")
    t0 = time.time(); sid = None; chunks = []; finish = None
    with urllib.request.urlopen(req, timeout=900) as resp:
        for raw in resp:
            line = raw.decode(errors="replace").rstrip("\n")
            if not line.strip().startswith("data:"): continue
            try: ev = json.loads(line.strip()[5:].strip())
            except Exception: continue
            if ev.get("sessionId"): sid = ev["sessionId"]
            for k in ("text", "delta", "content"):
                v = ev.get(k)
                if isinstance(v, str) and v: chunks.append(v)
            if ev.get("finishReason"): finish = ev["finishReason"]
    out = {"session_id": sid, "elapsed_s": round(time.time()-t0, 1), "finish": finish,
           "claim_source": "round2" if result.get("round2", {}).get("text") else "round1",
           "claim_len": len(claim), "rebuttal": "".join(chunks)}
    (OUT / "exp16_debate_result.json").write_text(json.dumps(out, ensure_ascii=False, indent=2))
    print("DEBATE_DONE %.0fs finish=%s claim_len=%d rebuttal_len=%d session=%s" % (
        out["elapsed_s"], finish, len(claim), len(out["rebuttal"]), sid))

if __name__ == "__main__":
    main()
