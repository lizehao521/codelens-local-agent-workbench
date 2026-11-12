import { describe, it, expect } from 'vitest';
import { routeAfterA3, type AdoptMode } from '../scripts/auto-adopt.ts';

const redOk = { ok: true, reason: '基线红成立', premature: false };
const redFailPremature = {
  ok: false,
  reason: '判据因缺失的新 API 而 premature',
  premature: true,
};
const redFailOther = {
  ok: false,
  reason: '判据没有产生可验证的失败',
  premature: false,
};

function spec(mode?: AdoptMode) {
  return { mode };
}

describe('routeAfterA3（A、B 同时走的接缝）', () => {
  it('red-baseline：A3 通过 → 采纳', () => {
    expect(routeAfterA3(spec('red-baseline'), redOk).action).toBe('adopt');
  });

  it('red-baseline：A3 任何失败都拒绝（含 premature 假红）', () => {
    expect(routeAfterA3(spec('red-baseline'), redFailOther).action).toBe('reject');
    expect(routeAfterA3(spec('red-baseline'), redFailPremature).action).toBe('reject');
  });

  it('缺省 mode 当作 red-baseline：A3 premature 也拒绝', () => {
    expect(routeAfterA3(spec(undefined), redFailPremature).action).toBe('reject');
  });

  it('implement-first：A3 通过 → 采纳', () => {
    expect(routeAfterA3(spec('implement-first'), redOk).action).toBe('adopt');
  });

  it('implement-first：A3 因缺失新 API 而 premature → 路由去实现', () => {
    const r = routeAfterA3(spec('implement-first'), redFailPremature);
    expect(r.action).toBe('implement');
  });

  it('implement-first：A3 失败但非 premature（判据本身写错）→ 仍拒绝', () => {
    expect(routeAfterA3(spec('implement-first'), redFailOther).action).toBe('reject');
  });
});
