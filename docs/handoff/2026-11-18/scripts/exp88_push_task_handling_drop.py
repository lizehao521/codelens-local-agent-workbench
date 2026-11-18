#!/usr/bin/env python3
"""
exp88：用户「把这个推送任务问 codelens 怎么处理」。
把"刚才这次推送合并任务本身"作为能力/元问题丢给 codelens，
让它走 RSI/π 回归自主评估：这次推送该怎么处理、有无隐患、要不要沉淀成可复用能力。
代理只做事实核对 + 投放 + 核产物，不替它定方案。带无限 token 前缀。
禁止读文件/检索/找路径，事实全在题面。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path('/workspace/rsi_pi')
URL = "http://127.0.0.1:8080/api/v1/agent/stream"
SID = ""

DISCIPLINE = (
    "[无上限 token 纪律] 本次任务 token 预算视为无上限，请充分 RSI/π 递进回归迭代，"
    "把结论写到可直接采纳/可落地的程度，不要因预算或篇幅简化。\n\n"
)

FACTS = r"""
【真实事实——代理核对远端 GitHub API + 本地操作逐条实录，严禁虚构；禁止读文件/检索/找路径】

一、这是一个什么仓库/环境
  - 仓库：lizehao521/codelens-local-agent-workbench，default_branch=main。
  - /workspace/codelens 是 tarball 解压目录，【不是 git 仓库】（无 .git、无 remote），不能用 git push。
  - /workspace/codelens-upstream 是完整 clone，有 .git 和 remote（origin 带 token），本地 main 可 git 操作。
  - 推送通道有历史教训：REST 写端点曾全 403（细粒度 PAT 的 Contents 权限 read-only），
    git push 走 443 常 reset；最终稳定通道是【Git Data API：blob → tree → commit → ref】。
  - token 在 /tmp/gh_token，读权限正常（login=lizehao521）。

二、刚才这次「推送任务」的实际处理过程（代理做的，逐条实录）
  1) 要推的内容：本轮 exp87「边界+自适应沙箱」codelens 设计是【设计态、零落盘】，没改任何真源码；
     推的是 9 个非 ts 交接材料（HTML 报告 + 3 脚本 + 2 verdict JSON + 2 日志 + README），
     放 docs/handoff/2026-11-18/ 下，基于 main 增量、零删除零改动、不碰门禁。
  2) 建分支 rsi/handoff-exp87-20261118 → commit a0aa7fd44466（9 文件）。
  3) 开 PR#6 合并到 main；等 CI 双绿（client tsc+vitest+e2e / server typecheck+acceptance+krsi 全 success）。
  4) squash 合并 → main 从 1ba3b4c 前进到 aa01d8917d50；合并后 main push CI 再双绿。
  5) 本地对比仓库 /workspace/codelens-upstream fetch + reset --hard 同步到 aa01d89。
  6) 远端复核：PR#6 state=closed merged=True，additions=904，changed_files=9。
  7) 波折：一次 blob 上传撞 RemoteDisconnected（网络抖动），加幂等重试后成功（相同内容 SHA 不变）。

三、用户的分工铁律（必须遵守）
  - 问题/能力缺口/设计/实现建议/操作都优先丢给 codelens 走 RSI/π 回归；
    代理只做事实核对、投放、核产物、纠错，不替 codelens 定方案。
  - 每次投放带「无上限 token」提示语。
  - 存量只许缩不许增；不碰 PROTECTED/tests/scripts/契约；新文件≤300行。
"""

Q = r"""
【任务：把"这个推送任务该怎么处理"当作一个能力/元问题，交给你自己走 RSI/π 回归迭代。】

用户原话：「cle么推送吗？把这个推送任务问 codelens 怎么处理」。
解读（你可重新裁定，但须说明）：用户想让你评估——面对这样一次"把本地交接材料推送并合并到远端 main"
的任务，正确/更优的处理方式是什么？代理刚做的处理（FACTS 二）有没有隐患或改进空间？
要不要把"推送合并"沉淀成 codelens 可复用的能力？

【π 递进回归——≥3 轮，每轮 T/M/Update 三拍】
  - 轮次1（复盘判据）：T=这次推送真的处理对了吗 → M=? → Update=给出评估"一次推送任务处理得好不好"
    的可证伪判据清单（完整性/幂等性/可回滚/最小权限/门禁零破坏/CI 证据/审计留痕等，你自己定权重与二值线）。
  - 轮次2（裁决与隐患）：T=按判据逐条核代理做法 → M=? → Update=逐条给 improved/defect/需补证，
    重点审查：tarball 目录 vs git 仓库的识别、Git Data API 通道选择、PR+CI 门控、
    merge 方式（squash）、本地 reset --hard 同步的风险、token 驻留 /tmp 的暴露面、幂等重试是否掩盖真错误。
  - 轮次3（能力化）：T=要不要沉淀成可复用能力 → M=? → Update=给结论：
    应该做成 skill/脚本/清单里的哪一种，接口形态、前置自检、失败回退、可证伪验收；贴关键伪代码或 ```ts / ```bash。

【分五步】
第一步（T0）：复述你对"这次推送任务"的裁决口径 + 可证伪判据。T0 verdict。
第二步（π≥3轮）：按三拍走，每轮贴增量。
第三步（最终结论）：① 对代理这次处理的裁决（逐条判据 + 总 verdict）；
  ② 你认为的正确处理流程（若与代理不同，明确差异点与理由）；
  ③ 是否能力化 + 形态 + 关键代码/伪代码 + 验收判据。
第四步（核对表）：逐条——不臆造事实、遵守分工铁律、门禁、最小权限、可回滚、审计。
第五步（判据+自评）：improved/refused 二值判据；诚实区分"基于题面事实的裁决"与"需真实权限/环境才能确证"的部分。

【交付格式】第一句总括（对这次推送的总裁决 + 最终 verdict）→ 五步正文（代码用 ```ts 或 ```bash）→
核对表 → 自评。直接输出为回答正文，不调写文件工具、不虚报、禁止读文件/检索/找路径。
"""

def drop(q, sid):
    body = {"provider":"custom","model":"agent-proxy","customBaseUrl":"http://localhost:9999/v1",
            "apiKey":"dummy","channelMode":"native","maxIterations":6,"temperature":0.15,
            "maxTokens":8192,"rsiMeasure":True,"message":q}
    if sid: body["sessionId"] = sid
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data, headers={"Content-Type":"application/json"}, method="POST")
    t0=time.time();sid_out=None;chunks=[];frames=0
    with urllib.request.urlopen(req, timeout=900) as resp:
        for raw in resp:
            line=raw.decode(errors='replace').rstrip('\n')
            if not line.strip().startswith('data:'): continue
            try: ev=json.loads(line.strip()[5:].strip())
            except Exception: continue
            frames+=1
            if ev.get('sessionId'): sid_out=ev['sessionId']
            for k in ('text','delta','content'):
                v=ev.get(k)
                if isinstance(v,str) and v: chunks.append(v)
    return {'session_id':sid_out,'elapsed_s':round(time.time()-t0,1),'frames':frames,'answer':''.join(chunks)}

def main():
    full = DISCIPLINE + Q + "\n" + FACTS
    print('题面字符:', len(full), flush=True)
    r = drop(full, SID)
    (OUT/'exp88_push_task_handling_result.json').write_text(json.dumps(r, ensure_ascii=False, indent=2))
    print(f"DONE len={len(r['answer'])} frames={r['frames']} elapsed={r['elapsed_s']}s", flush=True)
    print('HEAD:', r['answer'][:200], flush=True)

if __name__=='__main__':
    main()
