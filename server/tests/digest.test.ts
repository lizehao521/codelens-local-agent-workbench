// digest 单测——参数摘要的确定性与 volatile 字段剔除
// 审批令牌绑定与循环检测共用同一摘要键（共享约定，防止"批准的参数"与"判重的参数"漂移）

import { describe, expect, it } from 'vitest';
import { argsDigest, callSignature, canonicalArgsJson } from '../src/utils/digest.js';

describe('digest', () => {
  it('键序无关：不同插入顺序得到相同 canonical JSON', () => {
    const a = canonicalArgsJson({ url: 'https://x.com', method: 'GET' });
    const b = canonicalArgsJson({ method: 'GET', url: 'https://x.com' });
    expect(a).toBe(b);
    expect(a).toBe('{"method":"GET","url":"https://x.com"}');
  });

  it('volatile 字段（timeoutMs/maxBytes/maxEntries/contextLines）不参与摘要', () => {
    const withVolatile = argsDigest({ path: 'a.txt', timeoutMs: 1000, maxBytes: 2048 });
    const without = argsDigest({ path: 'a.txt' });
    expect(withVolatile).toBe(without);
  });

  it('volatile 字段只在顶层剔除，嵌套对象内仍计入', () => {
    const topDropped = argsDigest({ path: 'a.txt', timeoutMs: 1000 });
    const nestedKept = argsDigest({ path: 'a.txt', options: { timeoutMs: 1000 } });
    const nestedOther = argsDigest({ path: 'a.txt', options: { timeoutMs: 2000 } });
    expect(topDropped).not.toBe(nestedKept);
    expect(nestedKept).not.toBe(nestedOther);
  });

  it('语义不同的参数得到不同摘要', () => {
    expect(argsDigest({ path: 'a.txt' })).not.toBe(argsDigest({ path: 'b.txt' }));
  });

  it('callSignature = 工具名 + 摘要（同参不同工具不算重复）', () => {
    const args = { expression: '1+1' };
    expect(callSignature('calc_evaluate', args)).toBe(`calc_evaluate:${argsDigest(args)}`);
    expect(callSignature('calc_evaluate', args)).not.toBe(callSignature('http_request', args));
  });
});
