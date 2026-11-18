#!/usr/bin/env python3
"""
exp87：用户「把边界扔给codelens，那个沙箱环境改成自适应」。
承接 exp67（自主边界声明只读镜像）+ 此前「目前它沙箱环境是什么」问答。
代理只做：事实核对 → 投题面 → 核产物。方案由 codelens 走 RSI/π 回归自主定。
带无限 token 纪律前缀。禁止读文件/检索/找路径，事实全在题面。
"""
import json, time, urllib.request
from pathlib import Path

OUT = Path("/workspace/rsi_pi")
URL = "http://127.0.0.1:8080/api/v1/agent/stream"
SID = ""

DISCIPLINE = (
    "[无上限 token 纪律] 本次任务 token 预算视为无上限，请充分 RSI/π 递进回归迭代，"
    "把设计写到可直接落地、可真跑验证的程度，不要因预算或篇幅简化。\n\n"
)

FACTS = r"""
【真实事实——代理逐行实读源码 + 真跑 health 核对，严禁虚构；禁止读文件/检索/找路径】

一、你此前已交付的「边界」能力（exp67，你自己产出的设计，未落盘）
  - 自主边界声明：三态字面量 autonomous / approval_required / never_exempt；
    覆盖白名单 16 命令 + sys.exec 共 17 条；node 因 execRequiresTwoStep 标 approval_required；
    sys.exec 标 never_exempt。
  - API：loadBoundary() / getBoundary(subject) / selfCheck(host)；HostBehaviorProbe 只读探针，
    声明模块不反向依赖执行逻辑；零行为变更首版；selfCheck 报 BOUNDARY_DRIFT 只告警不阻断。
  - 落点：security-gateway.ts 真路径 src/services/tools/security-gateway.ts，
    execRequiresTwoStep 定义在 security-gateway.ts 与 src/tools/builtin/sys-exec.policy.ts；
    均不在 PROTECTED（agent/judge/rsi/eval/tests）内。
  - 判据 A 一致性全绿 / B 漂移必报 / C 零行为变更（字节比对）。

二、当前「沙箱环境」真实现状（静态 jail，非自适应）——这是本次要改造的对象
  1) 根：SANDBOX_ROOT 环境变量，默认 <server package root>/workspace；本实例 .env 实配
     SANDBOX_ROOT=/workspace/codelens/server/workspace；启动时 mkdirSync 按需创建；fs 工具 jail against 它。
  2) 白名单 allowDirs：SandboxPermissionService(db, sandboxRoot) 惰性加载 + 内存缓存，
     PUT 后立即生效（运行时 CallResolver 持对象引用，原地 Object.assign 更新）。
     validateAllowDir 硬校验：绝对路径 / 真实存在目录 / realpath 后非沙箱根(及子孙或祖先) /
     非 RESTRICTED_DIR_PREFIXES(/etc /usr /root /home /var /proc /sys ... 及 Windows 对应) /
     非 isSensitivePath(.ssh/.aws/浏览器配置/密钥)。symlink 逃逸 realpath 后拒绝。
  3) autoApprove 三个开关：fsDestructive / purge / httpWrite，默认全 false；
     【硬约束】禁止为 sys.exec 新增豁免键——exemptCategory('sys.exec') 恒 null，
     runGateway 对 exec 落 approvalMode==='none' 直接 SECURITY_DENIED 兜底。
  4) grants 按目录授权：工作区外首次访问 → 弹一次授权 → 记住不再弹；只授权目录、
     .. 穿越永不弹(直接拒)、敏感路径永不弹(直接拒)、设备级持久化(写 revoked_at)、
     超时 fail-closed deny、会话中止全 deny；activeDirs() 合并进 gateway 的 allowedDirs。
  5) 探针 probeSandboxWritable(sandboxRoot) 在 /api/health 暴露 sandbox.writable；
     本实例真跑 health：sandbox.rootConfigured=true, writable=true, db 23 表 ok。
  6) 相关文件（真路径，供你判断落点）：services/tools/sandbox-permission{.ts,.service.ts}、
     sandbox-grant.service.ts、validators/sandbox-permission.schema.ts、controllers/sandbox-{permissions,grants}.controller.ts、
     repositories/sandbox-{permission,grant}.repository.ts、utils/sandbox-probe.ts、tools/builtin/sandbox-walk.ts。
  7) node 命令被 execRequiresTwoStep 判定两步确认（security-gateway.ts 约 463 行 `if (name==='node') return true`），
     这是自动化链路里 node 需审批的既有事实。

三、硬门禁（写入边界）
  - 沙箱 path jail 只到 /workspace/codelens/server/workspace，碰不到真源码 src/；
    因此你交付的是【宿主侧可落地的设计 + 关键代码草稿】，严禁声称"我已落盘/已改真源码"。
  - PROTECTED：tests/、scripts/、agent/、judge/、rsi/、eval/；新文件 ≤300 行；
    不碰 metrics_json / verdict 七值 / error_kind / 不新增 outcome；存量只许缩不许增。
  - strict tsc + noUncheckedIndexedAccess 可过；无 any（测试断言处 as 可接受）。
"""

Q = r"""
【任务：把「边界」与「沙箱环境自适应」两件事一起丢回给你，走 RSI/π 回归自主迭代。】

用户诉求原文：「把边界扔给codelens，那个沙箱环境改成自适应」。
解读（你可在设计态自己重新裁定，但须说明）：
  (A) 边界——承接你 exp67 的自主边界声明，本轮要你把它从"只读镜像设计"推进到
      "与自适应沙箱联动的可用边界"：边界声明如何成为自适应的输入/约束，而非散布的硬编码。
  (B) 沙箱环境改成自适应——当前是静态 jail（固定根 + 静态白名单 + 三个手动开关 + 按目录授权）。
      你要自主设计"自适应沙箱环境"：让沙箱边界能依据任务上下文/风险信号/历史行为动态调整，
      而不是全靠人手动配 allowDirs。具体怎么"自适应"由你裁定，但必须可证伪、可跑、不破安全底线。

【π 递进回归——≥3 轮，每轮 T/M/Update 三拍 + 贴代码增量】
  - 轮次1（现状与风险）：T=静态沙箱在长任务/多目录场景要人反复授权、易过授权疲劳
    → M=? → Update=给出"自适应"的精确定义与可证伪判据；明确哪些维度可调、哪些是绝对硬底线
    （jail / SSRF / sys.exec never_exempt / 敏感路径 不可自适应放宽）。
  - 轮次2（方案）：T=要给可落地设计 → M=? → Update=给完整设计：自适应决策的输入信号、判定逻辑、
    与边界声明表(selfCheck)的联动、状态机/数据结构、API 形态；贴关键 TS 代码（含落点文件）。
  - 轮次3（回归与门禁）：T=要真跑验证 → M=? → Update=给可跑探针设计（<300行）：
    至少覆盖"自适应放行正当目录"+"越界仍 SECURITY_DENIED"+"敏感路径永不自适应放行"+
    "sys.exec 永不自适应豁免"+"自适应决策可审计/可回滚"；逐条对门禁 → 最终 verdict。

【分五步】
第一步（T0）：复述你对"自适应沙箱"的精确定义 + 绝对硬底线清单（哪些永不自适应）。T0 verdict。
第二步（π 回归 ≥3 轮）：按三拍走，每轮贴代码/结构增量。
第三步（最终设计）：① 自适应沙箱完整设计（信号→判定→执行→审计）；
  ② 与边界声明表的联动方式；③ 关键 TS 代码（落点文件 + 新文件 ≤300 行）；④ 可跑探针；⑤ 真跑命令。
第四步（核对表）：逐条——不破 jail/SSRF/sys.exec/敏感路径底线、不碰 PROTECTED、
  存量只缩、strict tsc、无 any、新文件行数、零行为变更或明确说明行为变更点。
第五步（判据+自评）：improved/refused 二值判据 + 可证伪条件（什么情况下这个自适应设计应判 not_improved 回滚）；
  诚实列出"设计建议"与"需宿主落地"的边界，严禁声称已落盘。

【交付格式】第一句总括（能否落地 + 最终 verdict + 是否守住硬底线）→ 五步正文（代码 ```ts）→
核对表 → 自评。直接输出为回答正文，不调写文件工具、不虚报。
"""

def drop(q, sid):
    body = {"provider":"custom","model":"agent-proxy","customBaseUrl":"http://localhost:9999/v1",
            "apiKey":"dummy","channelMode":"native","maxIterations":6,"temperature":0.15,
            "maxTokens":8192,"rsiMeasure":True,"message":q}
    if sid:
        body["sessionId"] = sid
    data = json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(URL, data=data,
                                 headers={"Content-Type":"application/json"}, method="POST")
    t0 = time.time(); sid_out=None; chunks=[]; writes=[]; frames=0
    with urllib.request.urlopen(req, timeout=900) as resp:
        for raw in resp:
            line = raw.decode(errors='replace').rstrip('\n')
            if not line.strip().startswith('data:'): continue
            try: ev = json.loads(line.strip()[5:].strip())
            except Exception: continue
            frames += 1
            if ev.get('sessionId'): sid_out = ev['sessionId']
            for k in ('text','delta','content'):
                v = ev.get(k)
                if isinstance(v,str) and v: chunks.append(v)
            args = ev.get('arguments')
            if isinstance(args,dict) and 'path' in args and 'content' in args:
                writes.append(args.get('path'))
    return {'session_id':sid_out,'elapsed_s':round(time.time()-t0,1),
            'frames':frames,'answer':''.join(chunks),'writes':writes}

def main():
    full = DISCIPLINE + Q + "\n" + FACTS
    print('题面字符:', len(full), flush=True)
    r = drop(full, SID)
    (OUT/'exp87_boundary_adaptive_sandbox_result.json').write_text(
        json.dumps(r, ensure_ascii=False, indent=2))
    print(f"DONE len={len(r['answer'])} frames={r['frames']} "
          f"writes={len(r['writes'])} elapsed={r['elapsed_s']}s", flush=True)

if __name__=='__main__':
    main()
