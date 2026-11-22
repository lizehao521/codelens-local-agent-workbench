# write-guard 引擎接入待办与集成测试草案

> 归档说明：以下 4 个集成测试断言 fs.write 接入写闸（WRITE_GATE_CLOSED / SYNTAX_REJECTED + 回滚）。
> 前一轮 RSI 的接入实现在 context_full 收尾时写出语法残片，已剔除（RSI迭代结果.md 第十三章）。
> 引擎接入完成前这些断言不适用于当前代码库，故从可执行测试套件移出，留档为待办。
> 纯函数（writeGateFor / firstSyntaxError）的 7 个测试仍全绿，见 write-guard.test.ts。

```ts
describe('fs.write · 高占用写闸（集成）', () => {
  it('occupancy ≥ 阈值时 create/overwrite 被拒为 NOT_RUN，且文件未落盘', async () => {
    const target = 'src/a.ts';
    for (const operation of ['create', 'overwrite'] as const) {
      const outcome = await fsWriteTool.handler(
        { path: target, operation, content: 'export const a = 1;\n' },
        ctx({ contextOccupancy: 0.95 }),
      );
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe('WRITE_GATE_CLOSED');
      expect(outcome.error?.kind).toBe('circuit_open');
      expect(outcome.summary).toContain('NOT_RUN');
    }
    await expect(readFile(path.join(root, target), 'utf8')).rejects.toThrow();
  });

  it('异常收尾原因下 replace 同样被拒', async () => {
    const target = 'b.ts';
    await writeFile(path.join(root, target), 'const x = 1;\n');
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'replace', oldText: 'const x = 1;', newText: 'const x = 2;' },
      ctx({ finishReason: 'context_full' }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('WRITE_GATE_CLOSED');
    // 原文件未被改动
    expect(await readFile(path.join(root, target), 'utf8')).toBe('const x = 1;\n');
  });

  it('占用正常时写入不受影响（闸门不误伤）', async () => {
    const outcome = await fsWriteTool.handler(
      { path: 'ok.ts', operation: 'create', content: 'export const ok = 1;\n' },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
    expect(await readFile(path.join(root, 'ok.ts'), 'utf8')).toBe('export const ok = 1;\n');
  });
});

describe('fs.write · 写入后语法自检 + 失败回滚（.ts 目标）', () => {
  it('写入残片内容时回滚到写入前状态并返回 SYNTAX_REJECTED', async () => {
    const target = 'core.ts';
    const original = 'export function f(): number {\n  return 1;\n}\n';
    await writeFile(path.join(root, target), original);
    const broken = 'export function f(): number {\n  return 1;\n}\nexport function f(): number {\n  return 2;\n';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'overwrite', content: broken },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('SYNTAX_REJECTED');
    expect(outcome.error?.kind).toBe('internal');
    expect(outcome.summary).toContain('已回滚');
    // 文件恢复原样 —— 异常收尾不自毁
    expect(await readFile(path.join(root, target), 'utf8')).toBe(original);
  });

  it('新建文件写入残片时删除该文件（回滚到"不存在"）', async () => {
    const target = 'new-broken.ts';
    const broken = 'function g( {\n';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'create', content: broken },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('SYNTAX_REJECTED');
    await expect(readFile(path.join(root, target), 'utf8')).rejects.toThrow();
  });

  it('合法 TS 内容正常落盘（自检不误伤）', async () => {
    const target = 'good.ts';
    const content = 'export function f(): number {\n  return 42;\n}\n';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'create', content },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
    expect(await readFile(path.join(root, target), 'utf8')).toBe(content);
  });

  it('非 TS 文件跳过语法自检（闸门只拦代码残片）', async () => {
    const target = 'notes.md';
    const outcome = await fsWriteTool.handler(
      { path: target, operation: 'create', content: '# 标题\n\n未闭合的括号 (\n' },
      ctx({ contextOccupancy: 0.3 }),
    );
    expect(outcome.ok).toBe(true);
  });
});
```
