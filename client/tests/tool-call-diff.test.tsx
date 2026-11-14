// 审批/结果卡 diff 渲染：+/-/@@ 三类行必须可区分，文件与增删行数必须可见。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolCallDiff } from '../src/components/agent/ToolCallDiff';

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ToolCallDiff', () => {
  it('显示路径、增删行数与 unified diff 文本', () => {
    act(() => {
      root.render(
        createElement(ToolCallDiff, {
          items: [
            {
              path: 'src/a.ts',
              added: 2,
              removed: 1,
              preview: '@@ -1,2 +1,3 @@\n-old\n+new\n+extra',
            },
          ],
        }),
      );
    });
    expect(container.textContent).toContain('src/a.ts');
    expect(container.textContent).toContain('+2');
    expect(container.textContent).toContain('-1');
    expect(container.textContent).toContain('+new');
    expect(container.textContent).toContain('-old');
  });

  it('多个文件时提示只显示前 4 个', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({
      path: `f${i}.ts`,
      added: 1,
      removed: 0,
      preview: '+x',
    }));
    act(() => root.render(createElement(ToolCallDiff, { items })));
    expect(container.textContent).toContain('仅显示前 4 个文件');
    expect(container.textContent).not.toContain('f4.ts');
  });
});
