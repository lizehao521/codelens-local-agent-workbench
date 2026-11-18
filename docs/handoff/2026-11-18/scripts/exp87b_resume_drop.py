#!/usr/bin/env python3
"""
exp87b：exp87 上游 429 中断后的同 sid 续投。codelens 已开始迭代（3轮 tool_calls），
让它接着上下文走完，直接产出完整五步交付。不重头、不换 sid。
"""
import json, time, urllib.request
from pathlib import Path
OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"
SID = "98035ee6-705a-49e7-8ae6-de570d2be154"

DISCIPLINE = (
    "[无上限 token 纪律] token 预算视为无上限，充分 RSI/π 递进回归迭代，"
    "把设计写到可直接落地、可真跑验证的程度，不要因预算或篇幅简化。\n\n"
)

RESUME = r"""
【续投说明】你上一轮已经开始了 RSI 迭代（确认了沙箱内结构、核对了验证入口），
但在中途上游遭遇 HTTP 429 quota exceeded，输出流被截断，只留下一句
「我先核对沙箱内实际结构与可用验证入口，再给出可落地设计；不会声称已修改宿主源码」。
这不是你的方案问题，是上游限流。配额现已恢复，请【从中断处继续】，不要从头再来。

请直接接着你已核对的事实，完成原任务「把边界扔给codelens，那个沙箱环境改成自适应」的完整交付：
(A) 边界——承接你 exp67 自主边界声明，推进到与自适应沙箱联动；
(B) 沙箱环境改成自适应——静态 jail → 自适应；你自主裁定"自适应"的精确定义，
    但绝对硬底线不可自适应放宽：jail / SSRF / sys.exec never_exempt / 敏感路径。

【π 递进回归——≥3 轮，每轮 T/M/Update 三拍 + 贴代码增量】
  - 轮次1：给"自适应沙箱"精确定义 + 可证伪判据 + 绝对硬底线清单（哪些永不自适应）。
  - 轮次2：完整设计（信号→判定→执行→审计）+ 与边界声明表 selfCheck 的联动 + 关键 TS 代码（落点文件、新文件≤300行）。
  - 轮次3：可跑探针设计（<300行），覆盖：自适应放行正当目录 / 越界仍 SECURITY_DENIED /
    敏感路径永不自适应放行 / sys.exec 永不自适应豁免 / 决策可审计可回滚；逐条对门禁。

【分五步】T0 定义与硬底线 → π≥3轮（每轮贴增量）→ 最终设计（含关键TS代码+探针+真跑命令）→
核对表（不破 jail/SSRF/sys.exec/敏感路径、不碰 PROTECTED、存量只缩、strict tsc、无 any、新文件行数）→
判据+自评（improved/refused、可证伪回滚条件、诚实区分"设计建议"与"需宿主落地"，严禁声称已落盘）。

【交付格式】第一句总括（最终 verdict + 是否守住硬底线）→ 五步正文（代码 ```ts）→ 核对表 → 自评。
直接输出为回答正文，不调写文件工具、不虚报。事实以你上一轮已核对的为准，禁止读文件/检索/找路径。
"""

Q = DISCIPLINE + RESUME

def drop(q, sid):
    body={"provider":"custom","model":"agent-proxy","customBaseUrl":"http://localhost:9999/v1",
          "apiKey":"dummy","channelMode":"native","maxIterations":6,"temperature":0.15,
          "maxTokens":8192,"rsiMeasure":True,"message":q}
    if sid: body["sessionId"]=sid
    data=json.dumps(body,ensure_ascii=False).encode()
    req=urllib.request.Request(URL,data=data,headers={"Content-Type":"application/json"},method="POST")
    t0=time.time();sid_out=None;chunks=[];writes=[];frames=0;tail=''
    with urllib.request.urlopen(req,timeout=900) as resp:
        for raw in resp:
            line=raw.decode(errors='replace').rstrip('\n')
            if not line.strip().startswith('data:'):continue
            try:ev=json.loads(line.strip()[5:].strip())
            except:continue
            frames+=1
            if ev.get('sessionId'):sid_out=ev['sessionId']
            for k in ('text','delta','content'):
                v=ev.get(k)
                if isinstance(v,str) and v:chunks.append(v)
            args=ev.get('arguments')
            if isinstance(args,dict) and 'path' in args and 'content' in args:writes.append(args.get('path'))
    ans=''.join(chunks)
    return {'session_id':sid_out,'elapsed_s':round(time.time()-t0,1),'frames':frames,
            'answer':ans,'writes':writes,'tail':ans[-300:]}

def main():
    print('题面字符:',len(Q),flush=True)
    r=drop(Q,SID)
    (OUT/'exp87b_resume_result.json').write_text(json.dumps(r,ensure_ascii=False,indent=2))
    print(f"DONE len={len(r['answer'])} frames={r['frames']} elapsed={r['elapsed_s']}s",flush=True)
    print('TAIL:',r['tail'][:200],flush=True)

if __name__=='__main__':main()
