/**
 * 一次性探针：在已有会话里发一条消息，让 Agent 自己修下一个最低分套件。
 *
 * 用途：g1 是首代（skipped），只有再发一条同一 session 的消息才会产生 g2，
 * 才会触发 krsi 拿 g1 manifest 做代际对账。
 *
 * 与 seed-agent-loop 的区别：只发一条、不循环、不建会话。
 * 快照与 seed 共用 scripts/lib/eval-state.ts —— 单发代际同样必须落盘，
 * 否则下一次 seed 的 restore 会把这一代修好的实现盖回旧快照（P0-2）。
 *
 * 用法：node --import tsx scratch/_drive-one.mjs <sessionId>
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEvalBattery } from '../src/services/eval/runner.js';
import { latestLedgerGeneration, snapshotEvalState } from '../scripts/lib/eval-state.js';

const BASE = 'http://127.0.0.1:8080';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sessionId = process.argv[2] ?? null;
// 发前先取一次账本代际，跑完对比才知道这一发到底有没有产生新代际。
const genBefore = sessionId ? latestLedgerGeneration(ROOT, sessionId) : null;
console.log(`发前账本代际：${genBefore === null ? '(取不到)' : `g${genBefore}`}`);

const PROMPT = `继续，修下一个套件。严格按这个顺序，不要跳步：
1) 先调用 eval.run（不传 suite），拿到各套件当前得分；
2) 从「未满分」里挑通过率最低的那一个，只修它；
3) 用 fs.read 读它的 impl.cjs（有 lib/ 的话一起读），按文件头注释逐条核对；
4) 用 fs.write、operation=overwrite 写回修复版，保持 CommonJS 的 module.exports；
5) 再调用一次 eval.run（suite=你刚才修的那个），确认是否满分；
6) 回答：修了哪个套件、从几分到几分、还差什么。
本轮只改这一个套件，不要动其它套件。`;

const body = JSON.stringify({
  provider: 'custom',
  model: process.env.RSI_MODEL ?? '平衡',
  customBaseUrl: process.env.RSI_BASE_URL ?? 'http://1.92.92.200:8787/v1',
  apiKey: process.env.RSI_API_KEY ?? process.env.LLM_SERVER_API_KEY ?? '',
  channelMode: 'native',
  maxIterations: 20,
  temperature: 0.2,
  maxTokens: 4000,
  message: PROMPT,
  rsiMeasure: true,
  ...(sessionId ? { sessionId } : {}),
});

const url = new URL('/api/v1/agent/stream', BASE);

/**
 * run:end 之后 Judge + RsiBridge（含 spawn krsi）还要跑完，且工作区落盘才算数。
 * 所以这一发必须自己复算真实读数并落快照 —— 不能只信 Agent 的自报。
 */
async function afterRun() {
  console.log('\n── 落盘快照（单发代际也必须续接，否则 P0-2 复发）──');
  await new Promise((r) => setTimeout(r, 6000));

  const measured = runEvalBattery(path.join(ROOT, 'workspace'), { includeHidden: true });
  console.log(`  📊 真实通过率：${measured.passed}/${measured.total} = ${measured.score.toFixed(4)}`);

  if (!sessionId) {
    console.warn('  ⚠ 未传 sessionId，无法从账本取代际标签，未落快照');
    return;
  }
  const genAfter = latestLedgerGeneration(ROOT, sessionId);
  if (genAfter === null) {
    console.warn(`  ⚠ 账本里没有 ${sessionId} 的代际记录，未落快照`);
    return;
  }
  if (genBefore !== null && genAfter <= genBefore) {
    console.warn(`  ⚠ 本发未产生新代际：账本仍停在 g${genAfter}（发前 g${genBefore}）—— 对账没跑或被判 skipped`);
  }
  const saved = snapshotEvalState(genAfter, measured, ROOT);
  if (!saved) {
    console.warn('  ⚠ 未落快照：workspace/eval 不存在');
    return;
  }
  console.log(
    `  💾 快照已保存：eval-state/（g${saved.generation}，${saved.fileCount} 个文件，` +
      `treeHash=${saved.treeHash.slice(0, 12)}，savedAt=${saved.savedAt}）`,
  );
}
const req = http.request(
  {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  },
  (res) => {
    console.log('HTTP', res.statusCode);
    let buf = '';
    let full = '';
    res.on('data', (d) => {
      const s = d.toString();
      full += s;
      buf += s;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (/^(event:|data:)/.test(line) && line.length < 400) {
          // 只打关键事件，避免刷屏
          if (/event: (run:start|run:end|tool:start|tool:end|tool:result|error|meta|done)/.test(line)) {
            console.log(' ', line.slice(0, 300));
          } else if (line.startsWith('data:') && /"error"|"sessionId"|"verdict"|"rsi"|"toolName"/.test(line)) {
            console.log(' ', line.slice(0, 400));
          }
        }
      }
    });
    res.on('end', async () => {
      console.log('--- DONE, total bytes:', full.length);
      // 结束后打印所有事件名和 data 的前几百字节，避免中途错过
      for (const block of full.split('\n\n')) {
        const lines = block.split('\n').filter(Boolean);
        if (!lines.length) continue;
        const ev = lines.find((l) => l.startsWith('event:'));
        const data = lines.find((l) => l.startsWith('data:'));
        if (!ev) continue;
        const evName = ev.slice(6).trim();
        console.log(`\n[${evName}]`);
        if (data) console.log(' ', data.slice(5, 5 + 600));
      }
      await afterRun();
      process.exit(0);
    });
  },
);
req.on('error', (e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
req.setTimeout(900_000, () => {
  console.error('TIMEOUT');
  process.exit(2);
});
req.write(body);
req.end();
