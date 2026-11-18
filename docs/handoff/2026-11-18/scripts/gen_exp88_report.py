#!/usr/bin/env python3
"""生成 exp88「推送任务怎么处理」RSI/π 迭代裁决报告。"""
import json
import markdown
from pathlib import Path

BASE = Path('/workspace')
r = json.loads((BASE/'rsi_pi/exp88_push_task_handling_result.json').read_text())
ans = r['answer']

CSS = r"""
  :root { --ink:#1a1c23; --sub:#5b6472; --line:#e3e7ee; --bg:#f7f8fa; --card:#fff;
          --red:#c0392b; --blue:#2c5aa0; --green:#1e7d5a; --amber:#b8860b; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font-family:"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif;
         line-height:1.7; padding:32px 20px 60px; }
  .wrap { max-width:960px; margin:0 auto; }
  .hero { background:linear-gradient(135deg,#8a5a10,#b8860b); color:#fff; border-radius:16px;
          padding:28px 32px; box-shadow:0 8px 28px rgba(184,134,11,.22); }
  .hero h1 { margin:0 0 6px; font-size:24px; letter-spacing:.5px; }
  .hero .code { font-family:ui-monospace,Consolas,monospace; font-size:13px; opacity:.9; }
  .hero .lead { margin-top:14px; font-size:15px; opacity:.97; }
  .verdict { display:inline-block; margin-top:14px; background:rgba(255,255,255,.16);
             border:1px solid rgba(255,255,255,.35); border-radius:999px; padding:4px 14px; font-size:13px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px;
          padding:22px 26px; margin-top:18px; box-shadow:0 2px 10px rgba(20,30,50,.04); }
  h2 { font-size:19px; margin:0 0 14px; padding-left:11px; border-left:4px solid var(--amber); }
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
<title>推送任务怎么处理 · RSI/π 迭代裁决（exp88）</title>
<style>{CSS}</style></head><body><div class="wrap">

<div class="hero">
  <h1>「推送任务怎么处理」· RSI/π 迭代裁决</h1>
  <div class="code">exp88 · 2026-11-18 · 上游 moonshotai/kimi-k3.1-pro（经 :9999 relay）</div>
  <div class="lead">用户「把这个推送任务问 codelens 怎么处理」——把刚完成的推送合并任务本身作为能力/元问题丢回 codelens，让它自主评估处理方式、找隐患、定能力化方案。代理只做事实核对 + 投放 + 核产物。</div>
  <div class="verdict">总裁决：improved（有条件通过）· 远端链路正确 · 2 处流程卫生 defect · 建议沉淀为窄边界 skill</div>
</div>

<div class="card">
  <h2>一、投放概况</h2>
  <table>
    <tr><th>项</th><th>内容</th></tr>
    <tr><td>诉求原文</td><td>cle么推送吗？把这个推送任务问 codelens 怎么处理</td></tr>
    <tr><td>解读</td><td>不是"再推一次"，而是"这类推送任务怎样处理才算正确、代理这次有没有隐患、要不要沉淀成能力"</td></tr>
    <tr><td>投放纪律</td><td>带「无上限 token」前缀，充分 RSI/π 递进回归迭代</td></tr>
    <tr><td>链路状态</td><td>沙箱休眠三端口全 down → 重启 relay/gh-proxy/app（health 200）后投放</td></tr>
    <tr><td>产物规模</td><td>9482 字 / 432 帧 / 127.7s；五步齐全；9 项逐条裁决（7 improved + 2 defect）</td></tr>
    <tr><td>结论</td><td><span class="tag warn">improved 有条件</span> 核心任务完成、门禁未破；扣分项为流程卫生，能力化前须修</td></tr>
  </table>
</div>

<div class="card">
  <h2>二、codelens 逐条裁决摘要（代理核产物提炼）</h2>
  <table>
    <tr><th>判据项</th><th>裁决</th><th>要点</th></tr>
    <tr><td>推送对象与边界</td><td><span class="tag ok">improved</span></td><td>9 个非 ts 交接材料、基于 main 增量、零删除零改动；设计态零落盘如实区分</td></tr>
    <tr><td>tarball vs git 识别</td><td><span class="tag ok">improved</span></td><td>关键正确点：/workspace/codelens 无 .git，未在 tarball 目录硬做 git push</td></tr>
    <tr><td>Git Data API 通道</td><td><span class="tag ok">improved</span></td><td>403/reset 历史下合理；须避免用其直接更新 refs/heads/main</td></tr>
    <tr><td>PR + CI + 合并后复核</td><td><span class="tag ok">improved</span></td><td>分支→PR→合并前双绿→squash→合并后 main 再双绿，证据链完整</td></tr>
    <tr><td>幂等重试</td><td><span class="tag ok">improved·附条件</span></td><td>网络类可重试、SHA 稳定；须按错误类型分类，401/403/422 不得重试冲过</td></tr>
    <tr><td>可回滚与审计</td><td><span class="tag ok">improved</span></td><td>base/branch commit/merge commit 齐全，可 revert 不改写公共历史</td></tr>
    <tr><td>本地 reset --hard 同步</td><td><span class="tag bad">defect</span></td><td>破坏性原语；应默认 ff-only，先证明工作区干净；本次是否造成损失需补证</td></tr>
    <tr><td>token 落 /tmp/gh_token</td><td><span class="tag bad">defect</span></td><td>秘密卫生；应受控注入、0600、用后清理、不进日志；是否实际泄露需补证</td></tr>
    <tr><td>新文件 ≤300 行</td><td><span class="tag warn">需补证</span></td><td>题面未给逐文件行数，不能由 additions=904 推断每个合规</td></tr>
  </table>
  <div class="note">能力化结论：做成 <code>handoff-pr-publish</code> 窄边界 skill（只读预检 + Git Data API 增量推送 + PR/CI 门控 + 可回滚审计），不处理源码自动修复、不放宽 CI、不直推 main、不默认强推/全 squash。</div>
</div>

<div class="card">
  <h2>三、codelens 完整交付（原文正文）</h2>
  <div class="md-body">{body_html}</div>
</div>

<div class="card">
  <h2>四、代理核产物结论</h2>
  <table>
    <tr><th>核对项</th><th>结果</th></tr>
    <tr><td>五步齐全</td><td><span class="tag ok">通过</span> T0 判据 / π≥3轮 / 最终结论 / 核对表 / 判据+自评</td></tr>
    <tr><td>不臆造事实</td><td><span class="tag ok">通过</span> 只用题面事实（仓库、目录性质、commit、PR、CI、文件数、token 位置），未声称实读文件/调远端</td></tr>
    <tr><td>遵守分工铁律</td><td><span class="tag ok">通过</span> 方案与判据交给 codelens；代理角色仍限事实核对/投放/核产物/纠错</td></tr>
    <tr><td>自我批评有效性</td><td><span class="tag ok">有价值</span> 主动指出代理 reset --hard 与 token 落盘两处隐患，并诚实标"需补证"未夸大为已泄露/已丢数据</td></tr>
    <tr><td>能力化可执行</td><td><span class="tag ok">通过</span> 给出接口、前置自检、错误分类、验收判据与伪代码，边界窄且可证伪</td></tr>
  </table>
  <div class="note">对代理的后续启示（codelens 提出、尚未执行）：① 本地同步改 ff-only，reset --hard 需先证明干净且留备份引用；② token 改受控注入 0600 用后清理；③ 投放模板固定带无限 token 字段。这些是改进建议，代理本轮未回改已合并的 PR#6（远端结果已复核正确）。</div>
</div>

<div class="foot">产物：exp88_push_task_handling_drop.py · exp88_push_task_handling_result.json · exp88_drop.log ｜ 代理未改任何真源码、未重推</div>

</div></body></html>"""

out = BASE/'rsi_pi_exp88_push_task_handling_report.html'
out.write_text(html_doc, encoding='utf-8')
print('WROTE', out, 'len=', len(html_doc))
