/**
 * propose-gaps → self-upgrade-loop 的机器可读结果协议。
 *
 * 背景：循环原来无条件打印「提议记在 proposals.jsonl」，而子脚本被筛掉时
 * 退出码仍是 0、拒绝原因又被 slice(-10) 截掉——日志说成功，实际没写。
 * 现在子脚本在 stdout 末尾打一行 RESULT:<JSON>，循环据此诚实汇报。
 * 旧版子脚本没有 RESULT 行：parseResult 返回 null，循环回退为「不声称落盘」。
 */
export interface ProposeResult {
  status: 'accepted' | 'rejected' | 'no-proposal' | 'duplicate';
  id?: string;
  reason?: string;
  targetFile?: string;
}

export const RESULT_PREFIX = 'RESULT:';

export function formatResult(r: ProposeResult): string {
  return RESULT_PREFIX + JSON.stringify(r);
}

export function parseResult(out: string): ProposeResult | null {
  const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith(RESULT_PREFIX)) continue;
    try {
      const j = JSON.parse(line.slice(RESULT_PREFIX.length)) as ProposeResult;
      if (j && typeof j.status === 'string') return j;
    } catch {
      /* 坏行忽略，继续往前找 */
    }
  }
  return null;
}

/** 循环侧的状态行。不变量：只有 accepted 才出现「已记入」。 */
export function proposeStatusLine(result: ProposeResult | null, runOk: boolean): string {
  if (!runOk) return '  ⛔ 提议环节失败（子进程退出码非 0），未落盘';
  if (result?.status === 'accepted') {
    return `  ✔ 提议已记入 .self-upgrade/proposals.jsonl（${result.id ?? '?'}｜靶子 ${result.targetFile ?? '?'}）`;
  }
  if (result) {
    const parts = [`  ⛔ 提议未落盘：${result.status}`];
    if (result.reason) parts.push(result.reason);
    if (result.targetFile) parts.push(`靶子 ${result.targetFile}`);
    return parts.join('｜');
  }
  return '  ⚠ 未检测到 RESULT 行（旧版 propose-gaps 输出）——不声称已落盘';
}