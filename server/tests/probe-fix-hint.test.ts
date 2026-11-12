/**
 * 探针被拒时的反馈，必须按 kind 分流。
 *
 * 现场（2026-11-12 第四轮，fs-read-maxbytes-default-mismatch）：
 * 探针把 `path.join(process.cwd(), 'probe.txt')` 这个**绝对路径**传给了 fs.read，
 * 前置校验按越界拒成 kind=security。参数键（path）完全正确，只错在"绝对"。
 * 而当时的 fix 文案是一句写死的「照 inputSchema 调用，不要自造 operations 数组」——
 * 让它去改字段名。方向相反，下一轮只会继续改键名。
 *
 * 反馈不按证据分流，就是在教它学错东西。这组用例钉住分流表。
 */

import { describe, expect, it } from 'vitest';
import { probeFixHint } from '../scripts/auto-adopt.js';

describe('probeFixHint：按 kind 给可照改的指令', () => {
  it('security → 指出是路径问题，给出 path.relative 的写法', () => {
    const hint = probeFixHint({ reason: '探针自报被前置校验拦住（kind=security）', kind: 'security' });
    expect(hint).toContain('沙箱相对路径');
    expect(hint).toContain('path.relative');
    // 不许把它引到字段名上去
    expect(hint).not.toContain('inputSchema');
  });

  it('invalid_args → 才谈字段与枚举', () => {
    const hint = probeFixHint({ reason: '…（kind=invalid_args）', kind: 'invalid_args' });
    expect(hint).toContain('inputSchema');
    expect(hint).toContain('required');
  });

  it('not_found → 先建夹具文件，而不是改参数', () => {
    const hint = probeFixHint({ reason: '…（kind=not_found）', kind: 'not_found' });
    expect(hint).toContain('夹具');
    expect(hint).not.toContain('inputSchema');
  });

  it('timeout → 换最小输入，而不是换调用方式', () => {
    const hint = probeFixHint({ reason: '…（kind=timeout）', kind: 'timeout' });
    expect(hint).toContain('最小输入');
  });

  it('未知 kind → 不编造原因，要求先看清 kind', () => {
    const hint = probeFixHint({ reason: '某句没头没尾的话' });
    expect(hint).toContain('kind=?');
    // 不要退化成"随便改改"这类空话
    expect(hint).toContain('不要靠换字段名蒙过去');
  });

  it('金丝雀：同一段 reason、不同 kind，给出的指令必须不同', () => {
    const a = probeFixHint({ reason: '探针被拦住', kind: 'security' });
    const b = probeFixHint({ reason: '探针被拦住', kind: 'invalid_args' });
    expect(a).not.toBe(b);
  });
});
