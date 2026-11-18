#!/usr/bin/env python3
"""生成 exp87 边界+自适应沙箱 RSI/π 迭代设计报告。"""
import json
import markdown
from pathlib import Path

BASE = Path('/workspace')
r2 = json.loads((BASE/'rsi_pi/exp87b_resume_result.json').read_text())
ans = r2['answer']

CSS = r"""
  :root { --ink:#1a1c23; --sub:#5b6472; --line:#e3e7ee; --bg:#f7f8fa; --card:#fff;
          --red:#c0392b; --blue:#2c5aa0; --green:#1e7d5a; --amber:#b8860b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
         line-height:1.7; padding:32px 20px 60px; }
  .wrap { max-width:960px; margin:0 auto; }
  .hero { background:linear-gradient(135deg,#1f5c7a,#2c5aa0); color:#fff; border-radius:16px;
          padding:28px 32px; box-shadow:0 8px 28px rgba(31,92,122,.22); }
  .hero h1 { margin:0 0 6px; font-size:25px; letter-spacing:.5px; }
  .hero .code { font-family:ui-monospace,Consolas,monospace; font-size:13px; opacity:.9; }
  .hero .lead { margin-top:14px; font-size:15px; opacity:.97; }
  .verdict { display:inline-block; margin-top:14px; background:rgba(255,255,255,.16);
             border:1px solid rgba(255,255,255,.35); border-radius:999px; padding:4px 14px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:22px 26px; margin-top:18px; box-shadow:0 2px 10px rgba(20,30,50,.04); }
  h2 { font-size:19px; margin:0 0 14px; padding-left:11px; border-left:4px solid var(--blue); }
  .card h3 { font-size:15.5px; margin:16px 0 8px; color:var(--blue); }
  .card h4 { font-size:14px; margin:12px 0 6px; color:#344; }
  pre { background:#1e2430; color:#d6deea; border-radius:8px; padding:14px 16px; overflow-x:auto;
        font-size:12.5px; line-height:1.55; margin:10px 0; }
  code { font-family:ui-monospace,Consolas,monospace; }
  p code, li code, td code { background:#eef1f6; color:#b02a5b; padding:1px 5px; border-radius:4px; font-size:12.5px; }
  .def { background:#f0f4fb; border-left:3px solid var(--blue); padding:12px 16px;
         border-radius:0 8px 8px 0; margin:10px 0; font-size:14.5px; }
  .note { background:#fdf6e8; border-left:3px solid var(--amber); padding:12px 16px;
          border-radius:0 8px 8px 0; margin:10px 0; font-size:14px; }
  table { width:100%; border-collapse:collapse; margin-top:10px; font-size:13.3px; }
  th,td { border:1px solid var(--line); padding:8px 11px; text-align:left; vertical-align:top; }
  th { background:#f2f5fa; font-weight:600; }
  .tag { display:inline-block; padding:1px 8px; border-radius:6px; font-size:12px; font-weight:600; }
  .ok { background:#e6f4ee; color:var(--green); }
  .warn { background:#fdf3dc; color:var(--amber); }
  .bad { background:#fbeceb; color:var(--red); }
  ul,ol { margin:8px 0; padding-left:22px; }
  li { margin:4px 0; }
  .foot { color:var(--sub); font-size:12.5px; text-align:center; margin-top:24px; }
  .md-body blockquote { margin:10px 0; padding:8px 14px; background:#f5f7fa;
        border-left:3px solid var(--green); border-radius:0 8px 8px 0; color:#334; }
"""

body_html = markdown.markdown(ans, extensions=['fenced_code', 'tables', 'sane_lists'])

html_doc = f"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>边界 + 自适应沙箱 · RSI/π 迭代设计（exp87）</title>
<style>{CSS}</style></head><body><div class="wrap">

<div class="hero">
  <h1>边界 + 自适应沙箱 · RSI/π 递进迭代设计</h1>
  <div class="code">exp87 / exp87b · 2026-11-18 · 上游 moonshotai/kimi-k3.1-pro（经 :9999 relay）</div>
  <div class="lead">用户「把边界扔给 codelens，那个沙箱环境改成自适应」——代理只做事实核对 + 投放 + 核产物；方案由 codelens 自主 RSI/π 迭代产出。承接 exp67 自主边界声明，把静态 jail 升级为有界、可证伪、可回滚的自适应沙箱。</div>
  <div class="verdict">最终 verdict：improved（设计态）· 四条硬底线全守住 · 零落盘零真跑</div>
</div>

<div class="card">
  <h2>一、投放概况</h2>
  <table>
    <tr><th>项</th><th>内容</th></tr>
    <tr><td>诉求原文</td><td>把边界扔给 codelens，那个沙箱环境改成自适应</td></tr>
    <tr><td>投放纪律</td><td>带「无上限 token」前缀，充分 RSI/π 递进回归迭代</td></tr>
    <tr><td>链路状态</td><td>沙箱休眠致三端口全 down → 重启 relay :9999 / gh-proxy :9998 / app :8080（health 200，db 23 表，sandbox writable）</td></tr>
    <tr><td>波折</td><td>首投 exp87：上游主+备双 429 quota exceeded 中断（模型已跑 3 轮 tool_calls）；配额恢复后用同一 sessionId 续投 exp87b 走完</td></tr>
    <tr><td>产物规模</td><td>exp87b：15224 字 / 593 帧 / 264s；3 个 TS 代码块 + 1 个 bash 真跑命令；五步齐全</td></tr>
    <tr><td>结论</td><td><span class="tag ok">improved</span> 定义精确、硬底线守住、与 exp67 联动、零行为变更可开关回退</td></tr>
  </table>
</div>

<div class="card">
  <h2>二、代理事实核对（喂给 codelens 的题面事实，非方案）</h2>
  <div class="def">按用户铁律：代理不替 codelens 定方案，只把逐行实读的源码事实 + health 真跑结果作为题面喂给它，防止臆造；方案、判据、可证伪条件全部由它自己产出。</div>
  <table>
    <tr><th>事实面</th><th>真实实现</th></tr>
    <tr><td>沙箱根</td><td><code>SANDBOX_ROOT</code> 默认 &lt;server root&gt;/workspace；本实例 <code>/workspace/codelens/server/workspace</code>；fs 工具 jail against 它；health：writable=true</td></tr>
    <tr><td>白名单</td><td><code>SandboxPermissionService</code> 惰性加载 + 内存缓存，PUT 后立即生效；<code>validateAllowDir</code> 硬校验绝对路径/realpath/非沙箱根/非系统敏感目录/防 symlink 逃逸</td></tr>
    <tr><td>自动放行</td><td><code>fsDestructive / purge / httpWrite</code> 三开关默认 false；<code>sys.exec</code> 结构不可豁免（<code>exemptCategory</code> 恒 null，落 none 即 SECURITY_DENIED）</td></tr>
    <tr><td>按目录授权</td><td><code>SandboxGrantService</code>：首次访问弹窗记住、<code>..</code> 穿越永不弹、敏感路径永不弹、设备级持久化、超时 fail-closed、activeDirs 合并进 gateway</td></tr>
    <tr><td>边界（exp67）</td><td>三态 autonomous / approval_required / never_exempt；node 因 execRequiresTwoStep 标 approval_required；selfCheck 报 BOUNDARY_DRIFT 只告警不阻断；落点 src/services/tools/（非 PROTECTED）</td></tr>
    <tr><td>写入边界</td><td>jail 只到 server/workspace，碰不到真源码 src/；新文件 ≤300 行；不碰 metrics_json/verdict 七值/error_kind；存量只缩</td></tr>
  </table>
</div>

<div class="card">
  <h2>三、codelens 完整交付（原文正文）</h2>
  <div class="md-body">{body_html}</div>
</div>

<div class="card">
  <h2>四、代理核产物结论</h2>
  <table>
    <tr><th>核对项</th><th>结果</th></tr>
    <tr><td>五步齐全</td><td><span class="tag ok">通过</span> T0 定义+硬底线 / π≥3轮 / 最终设计+代码 / 核对表 / 判据+自评</td></tr>
    <tr><td>π 递进真实性</td><td><span class="tag ok">通过</span> 首投 relay 日志确证 3 轮 tool_calls（真实迭代，非一次成文）</td></tr>
    <tr><td>硬底线</td><td><span class="tag ok">守住</span> jail 根不变 / SSRF 零联动 / sys.exec never_exempt / 敏感路径判定前置即拒</td></tr>
    <tr><td>与 exp67 联动</td><td><span class="tag ok">自洽</span> 边界声明从「只读镜像」升级为自适应决策 L0/L2 硬约束输入；漂移期全局降级为 escalate_to_human</td></tr>
    <tr><td>可证伪/可回滚</td><td><span class="tag ok">具备</span> decide 为确定性纯函数可离线重放；每次授权带 rollbackToken；revoke 后 fail-closed</td></tr>
    <tr><td>行为变更</td><td><span class="tag warn">明确声明</span> 唯一变更：上下文明确引用且全校验通过的工作区外普通目录读操作由弹窗→临时只读自动放行；<code>ADAPTIVE_SANDBOX=off</code> 可整体回退</td></tr>
    <tr><td>落盘/真跑</td><td><span class="tag bad">未做（诚实）</span> 零落盘零真跑——jail 碰不到真源码，交付的是宿主侧设计草稿；tsc/vitest/health 真跑待宿主</td></tr>
  </table>
  <div class="note">生效条件：判定 improved，但以宿主真跑探针 G1–G6 全过为最终生效条件。任一红线用例被放行 / 产出写权限或永久授权 / 同信号不同判定 / revoke 失效 / 漂移期仍放行 / 模块内出现硬编码三态副本 —— 任一即判 not_improved 回滚。</div>
</div>

<div class="foot">产物：exp87_boundary_adaptive_sandbox_drop.py · exp87b_resume_drop.py · exp87_boundary_adaptive_sandbox_result.json · exp87b_resume_result.json · exp87_drop.log · exp87b_resume.log ｜ 代理未改任何真源码</div>

</div></body></html>"""

out = BASE/'rsi_pi_exp87_boundary_adaptive_sandbox_report.html'
out.write_text(html_doc, encoding='utf-8')
print('WROTE', out, 'len=', len(html_doc))
