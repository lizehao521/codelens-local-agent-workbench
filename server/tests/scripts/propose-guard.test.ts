/**
 * 公共 bug 修复包的机械验收：
 * 1. 保护路径单源：提示词清单与机械闸共用 PROTECTED_PATHS，不再「清单里有、闸却拒」。
 * 2. RESULT 协议：循环只在 accepted 时声称「已记入」；拒绝/旧版输出/失败都诚实汇报。
 */
import { describe, expect, it } from 'vitest';
import { PROTECTED_PATHS, isProtected } from '../../scripts/lib/protected-paths.js';
import { formatResult, parseResult, proposeStatusLine } from '../../scripts/lib/propose-result.js';
import { screen, sourceFiles } from '../../scripts/propose-gaps.js';
import { coveringDoneTasks, judgeCaseTitles, loadDoneTasks } from '../../scripts/propose-gaps.js';

const valid = {
  id: 'test-gap',
  title: '测试用缺口标题',
  gap: '这是一个足够长的缺口描述，超过十个字',
  evidence: ['src/utils/errors.ts:12 某输入下错误分型不对'],
  targetFile: 'src/utils/errors.ts',
  observable: '给定输入 X，期望输出 Y，可机械判定',
  boundary: '不碰判据与账本',
  gapType: 'defect' as const,
};

describe('保护路径单源', () => {
  it('每个受保护前缀都被 isProtected 命中', () => {
    for (const prefix of PROTECTED_PATHS) {
      expect(isProtected(`${prefix}anything.ts`)).toBe(true);
    }
  });

  it('普通源码文件不受保护', () => {
    expect(isProtected('src/app.ts')).toBe(false);
    expect(isProtected('src/services/agent/agent-loop.service.ts')).toBe(false);
  });

  it('screen 拒绝受保护靶子并给出原因（auto-eval-propose 现场复现）', () => {
    const r = screen({ ...valid, targetFile: 'src/services/judge/judge.service.ts' });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain('受保护路径');
    expect(r.reason).toContain('src/services/judge/');
  });

  it('screen 放行合法靶子', () => {
    expect(screen(valid).ok).toBe(true);
  });

  it('screen 仍挡非法 id / 不存在的文件', () => {
    expect(screen({ ...valid, id: 'Bad_ID' }).ok).toBe(false);
    expect(screen({ ...valid, targetFile: 'src/no-such-file-xyz.ts' }).ok).toBe(false);
  });

  it('sourceFiles 清单与闸一致：不含任何受保护文件', () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(f.startsWith('src/')).toBe(true);
      expect(isProtected(f)).toBe(false);
    }
  });
});

describe('判据感知：不重复提名已结题的缺陷', () => {
  it('能读到 done 题的靶子与判据断言', () => {
    const tasks = loadDoneTasks();
    expect(tasks.length).toBeGreaterThan(0);
    const codeCheck = tasks.find((t) => t.id === 'code-check');
    expect(codeCheck?.allowed).toContain('src/tools/builtin/code-check.tool.ts');
    const titles = judgeCaseTitles('tests/self-upgrade/code-check.test.ts');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.join('｜')).toContain('C1 已注册进内置工具表');
  });

  it('靶子落在 done 题 allowed 里且没有 notCoveredReason → 拒收并标 DONE_TASK_COVERED', () => {
    const r = screen({ ...valid, targetFile: 'src/tools/builtin/code-check.tool.ts' });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DONE_TASK_COVERED');
    expect(r.reason).toContain('code-check');
    expect(r.reason).toContain('notCoveredReason');
  });

  it('给了 notCoveredReason（≥10 字）→ 放行，交给出题环节判断', () => {
    const r = screen({
      ...valid,
      targetFile: 'src/tools/builtin/code-check.tool.ts',
      notCoveredReason: '现有断言只覆盖缺少列号，未覆盖列号越过文件末尾时的截断行为',
    });
    expect(r.ok).toBe(true);
  });

  it('notCoveredReason 敷衍（太短）仍然拒收', () => {
    const r = screen({
      ...valid,
      targetFile: 'src/tools/builtin/code-check.tool.ts',
      notCoveredReason: '不一样',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('DONE_TASK_COVERED');
  });

  it('未被任何 done 题覆盖的靶子不受影响', () => {
    expect(coveringDoneTasks('src/utils/errors.ts')).toHaveLength(0);
    expect(screen(valid).ok).toBe(true);
  });
});

describe('RESULT 协议', () => {
  it('格式化→解析往返一致（reason 含管道/冒号也不破坏）', () => {
    const r = { status: 'rejected' as const, reason: 'a|b:c', targetFile: 'src/app.ts', id: 'x-y' };
    expect(parseResult(formatResult(r))).toEqual(r);
  });

  it('取最后一条 RESULT 行', () => {
    const out = [
      formatResult({ status: 'rejected', reason: '旧' }),
      '中间诊断',
      formatResult({ status: 'accepted', id: 'final' }),
    ].join('\n');
    expect(parseResult(out)?.status).toBe('accepted');
    expect(parseResult(out)?.id).toBe('final');
  });

  it('旧版输出（无 RESULT 行）返回 null', () => {
    expect(parseResult('普通输出\n没有结果行')).toBeNull();
  });

  it('坏 JSON 的 RESULT 行被跳过', () => {
    expect(parseResult('RESULT:{bad json')).toBeNull();
  });
});

describe('循环诚实汇报（不变量：只有 accepted 才出现「已记入」）', () => {
  it('accepted → 声称已记入', () => {
    const line = proposeStatusLine({ status: 'accepted', id: 'x', targetFile: 'src/app.ts' }, true);
    expect(line).toContain('已记入');
  });

  it('rejected → 显示原因，绝不声称已记入', () => {
    const line = proposeStatusLine({ status: 'rejected', reason: 'targetFile 不能在受保护路径 src/services/judge/ 下', targetFile: 'src/services/judge/judge.service.ts' }, true);
    expect(line).toContain('受保护路径');
    expect(line).not.toContain('已记入');
  });

  it('no-proposal / duplicate → 不声称已记入', () => {
    expect(proposeStatusLine({ status: 'no-proposal' }, true)).not.toContain('已记入');
    expect(proposeStatusLine({ status: 'duplicate', id: 'x' }, true)).not.toContain('已记入');
  });

  it('旧版输出（null）→ 不声称已记入', () => {
    expect(proposeStatusLine(null, true)).not.toContain('已记入');
  });

  it('子进程失败 → 不声称已记入', () => {
    expect(proposeStatusLine({ status: 'accepted' }, false)).not.toContain('已记入');
  });
});