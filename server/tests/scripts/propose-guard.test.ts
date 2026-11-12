/**
 * 公共 bug 修复包的机械验收：
 * 1. 保护路径单源：提示词清单与机械闸共用 PROTECTED_PATHS，不再「清单里有、闸却拒」。
 * 2. RESULT 协议：循环只在 accepted 时声称「已记入」；拒绝/旧版输出/失败都诚实汇报。
 */
import { describe, expect, it } from 'vitest';
import { PROTECTED_PATHS, isProtected } from '../../scripts/lib/protected-paths.js';
import { formatResult, parseResult, proposeStatusLine } from '../../scripts/lib/propose-result.js';
import { screen, sourceFiles } from '../../scripts/propose-gaps.js';

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