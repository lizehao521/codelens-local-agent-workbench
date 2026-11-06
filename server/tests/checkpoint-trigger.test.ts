// 快照白名单筛选的单测 —— selectFilesToSnapshot 是纯函数（无 IO、无状态），
// 但它决定了「哪些文件会被拍进快照」，错了就是**安全网漏拍**或**无意义 IO**，
// 因此边界必须逐条钉死：
//   · 只认 fs.write（读操作不拍）
//   · rename 要同时算 path 与 newPath（目标被覆盖也要能还原）
//   · 缺 operation / 路径非字符串 / 空白路径 → 不拍
//   · 同一路径重复出现 → 去重

import { describe, expect, it } from 'vitest';
import { selectFilesToSnapshot } from '../src/services/agent/agent-loop.service.js';

interface Item {
  toolCall: { tool_name: string };
  args: Record<string, unknown>;
}

function item(toolName: string, args: Record<string, unknown>): Item {
  return { toolCall: { tool_name: toolName }, args };
}

describe('selectFilesToSnapshot', () => {
  it('fs.write 的 path 进入白名单', () => {
    const files = selectFilesToSnapshot([item('fs.write', { path: 'src/a.ts', operation: 'overwrite' })]);
    expect(files).toEqual(['src/a.ts']);
  });

  it('read / list 不进白名单（不改文件，拍它们只是浪费 IO）', () => {
    const files = selectFilesToSnapshot([
      item('fs.read', { path: 'src/a.ts' }),
      item('fs.list', { path: 'src' }),
    ]);
    expect(files).toEqual([]);
  });

  it('rename 同时算 path 与 newPath（目标被覆盖也要能还原）', () => {
    const files = selectFilesToSnapshot([
      item('fs.write', { path: 'old.txt', newPath: 'new.txt', operation: 'rename' }),
    ]);
    expect(files.sort()).toEqual(['new.txt', 'old.txt']);
  });

  it('delete 也要拍（删掉的文件必须能还原）', () => {
    const files = selectFilesToSnapshot([item('fs.write', { path: 'gone.txt', operation: 'delete' })]);
    expect(files).toEqual(['gone.txt']);
  });

  it('缺少 operation → 不拍（参数形态未知时宁可不拍）', () => {
    const files = selectFilesToSnapshot([item('fs.write', { path: 'src/a.ts' })]);
    expect(files).toEqual([]);
  });

  it('路径不是字符串 / 空白路径 → 不拍', () => {
    const files = selectFilesToSnapshot([
      item('fs.write', { path: 123, operation: 'overwrite' }),
      item('fs.write', { path: '   ', operation: 'overwrite' }),
      item('fs.write', { path: '', operation: 'overwrite' }),
    ]);
    expect(files).toEqual([]);
  });

  it('同一路径重复出现 → 去重', () => {
    const files = selectFilesToSnapshot([
      item('fs.write', { path: 'src/a.ts', operation: 'overwrite' }),
      item('fs.write', { path: 'src/a.ts', operation: 'append' }),
    ]);
    expect(files).toEqual(['src/a.ts']);
  });

  it('路径两侧空白被裁掉（避免落盘时出现带空格的怪路径）', () => {
    const files = selectFilesToSnapshot([item('fs.write', { path: '  src/a.ts  ', operation: 'overwrite' })]);
    expect(files).toEqual(['src/a.ts']);
  });

  it('空输入返回空数组（调用方据此跳过捕获，不产生空快照）', () => {
    expect(selectFilesToSnapshot([])).toEqual([]);
  });
});
