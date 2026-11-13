/**
 * 错误体形状护栏：控制器的 `.json({...})` 里不允许再出现字符串形式的 `error`。
 *
 * 背景：v2.11 前有 17 处 `{ error: '...' }` 与 `{ error: { code, message } }` 并存，
 * 前端必须写两套解析（SandboxGrantBar 就是受害者）。R2 统一后，这条判据防止
 * 回潮——它比 e2e 更早（不用起服务），也比单端点测试更全（扫全部控制器）。
 *
 * 为什么不用 ts-morph：静态类型分析对 `res.json()` 的实参类型没有额外约束力，
 * 而这条规则本质是文本契约，正则足够且零依赖。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTROLLERS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'controllers');

/** 单行 `{ error: '...' }` 或 `{ error: \`...\` }`：旧格式。 */
const INLINE_LITERAL = /\.json\(\{[^}]*\berror:\s*['"`]/;
/** `error: err.message` / `error: out.error` / `error: e?.message`：把异常消息直接当 error 值。 */
const RAW_MESSAGE = /\berror:\s*(err\.message|out\.error|e\?\.message)\b/;

describe('API 错误体形状（R2 回归）', () => {
  const files = readdirSync(CONTROLLERS).filter((f) => f.endsWith('.ts'));

  it('控制器里不再有字符串形式的 error', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(join(CONTROLLERS, file), 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (INLINE_LITERAL.test(line) || RAW_MESSAGE.test(line)) {
          offenders.push(`${file}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders, `以下位置仍是字符串错误体：\n${offenders.join('\n')}`).toEqual([]);
  });

  it('对象形状确实存在（防止正则失效后永远为绿）', () => {
    const total = files.reduce((n, file) => {
      const text = readFileSync(join(CONTROLLERS, file), 'utf8');
      return n + (text.match(/\berror:\s*\{/g)?.length ?? 0);
    }, 0);
    expect(total).toBeGreaterThanOrEqual(10);
  });
});
