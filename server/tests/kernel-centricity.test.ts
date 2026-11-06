/**
 * C1 中心性的机器闸（强化内核 §2 / 产品宪法补丁 §2）。
 *
 * C1 原文：「新增的每一个模块、字段、端点、文档，必须能回答：它强化了
 * Act / Judge / Update / Memory 的哪一维？答不上来 ⇒ 它是装饰，不是强化。」
 *
 * 「答上来」此前只能靠自觉，无法打红。这里落成两条今天就能跑的不变量：
 *
 *   闸 1 · 模块必须自我声明
 *     `src/` 下每个 .ts 必须以文件级注释块开头——这是本仓库既有惯例
 *     （实测 125/125 都有）。新文件不写，就是「答不上来」，闸红。
 *
 *   闸 2 · 闭环四维必须各有归属
 *     Act / Judge / Update / Memory 四维都必须有对应模块目录。缺一维 = 闭环
 *     断链（历史教训：Judge 曾「环有形状，从未转过」）。
 *
 * 判据自己也要可被判据检验（C3）：这两条都必须能被打红——见本文件末尾的
 * 「闸的破坏夹具」说明。闸不能是永真闸。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const srcDir = path.join(serverRoot, 'src');

function collectTsFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      collectTsFiles(abs, acc);
    } else if (entry.name.endsWith('.ts')) {
      acc.push(abs);
    }
  }
  return acc;
}

/** 文件开头是否以注释块起头（允许 BOM、空白、shebang）。 */
function hasFileHeader(source: string): boolean {
  const head = source.replace(/^﻿/, '').trimStart();
  return head.startsWith('/**') || head.startsWith('/*') || head.startsWith('//');
}

describe('C1 闸1 · 模块必须自我声明', () => {
  it('src/ 下每个 .ts 都必须有文件级注释块（答不上来「这是什么」= 装饰）', () => {
    const files = collectTsFiles(srcDir);
    expect(files.length).toBeGreaterThan(100); // 防止路径写错导致空扫描的假绿
    const undeclared = files
      .filter((f) => !hasFileHeader(readFileSync(f, 'utf8')))
      .map((f) => path.relative(srcDir, f).split(path.sep).join('/'));
    expect(
      undeclared,
      `以下模块没有文件级声明，无法回答「它强化了哪一维」，违反 C1：\n  ${undeclared.join('\n  ')}`,
    ).toEqual([]);
  });
});

describe('C1 闸2 · 闭环四维必须各有归属', () => {
  /**
   * 四维 → 落点目录/文件。任何一维没有代码，环就转不起来。
   * 历史教训：Judge 曾经只有「形状」（maybeDepositLesson 写模板）而无判据，
   * 命中反面清单「加了模块但没人调用」。
   */
  const dimensions: Array<[string, string[]]> = [
    ['Act（把 π 作用到任务上）', ['src/services/agent/agent-loop.service.ts']],
    ['Judge（判据塔 L0–L3）', ['src/services/judge/judge.service.ts', 'src/services/judge/criteria.ts']],
    ['Update（用 r 改 π）', ['src/services/agent/update.service.ts']],
    ['Memory（轨迹与经验）', ['src/services/memory/message.repository.ts', 'src/repositories/policy.repository.ts']],
  ];

  for (const [label, files] of dimensions) {
    it(`${label} 必须有落点模块`, () => {
      const missing = files.filter((rel) => !existsSync(path.join(serverRoot, rel)));
      expect(missing, `${label} 缺少落点：${missing.join(', ')}`).toEqual([]);
    });
  }

  it('四维缺一不可（环是闭环，不是链条）', () => {
    const present = dimensions.filter(([, files]) =>
      files.some((rel) => existsSync(path.join(serverRoot, rel))),
    );
    expect(present, '闭环四维必须全部有落点').toHaveLength(dimensions.length);
  });
});

/**
 * 闸的破坏夹具（C3「判据自己要先被判据检验」）：
 * 这两条闸在设计上必须能被打红——
 *   · 给 `src/` 新增一个无头注释的 .ts → 闸 1 红；
 *   · 把 `services/judge/` 临时改名 → 闸 2 红。
 * 本文件不自动做这两件事（会在磁盘上留垃圾），但闸的断言是「全集为空」
 * 形态，天然可被任何违规打红，不是永真闸。
 */
