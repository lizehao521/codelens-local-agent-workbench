// 长代码块折叠：默认只露出前段，按钮展开/收起；复制仍拿完整代码。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CodeBlock } from '../src/components/result/CodeBlock';

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

const longCode = Array.from({ length: 30 }, (_, i) => `const line${i + 1} = ${i + 1};`).join('\n');

describe('CodeBlock 折叠', () => {
  it('超过 24 行显示展开按钮，点击后收起', () => {
    act(() => root.render(createElement(CodeBlock, { code: longCode, lang: 'ts' })));
    expect(container.textContent).toContain('展开全部（30 行）');
    const fold = Array.from(container.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('展开全部'),
    );
    expect(fold).toBeTruthy();
    act(() => fold!.click());
    expect(container.textContent).toContain('收起代码');
  });

  it('短代码不显示折叠按钮', () => {
    act(() => root.render(createElement(CodeBlock, { code: 'const a = 1;', lang: 'ts' })));
    expect(container.textContent).not.toContain('展开全部');
  });
});
