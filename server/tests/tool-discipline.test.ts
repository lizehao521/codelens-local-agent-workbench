/**
 * §6 工具纪律的机器闸（静态工具时代的可执行子集）。
 *
 * 宣言 §6 要求：工具是任务期临时长出来的义肢，任务结束必须被吸收或截掉，
 * 配三条机器闸（孤儿工具闸 / 沉淀配对闸 / 写闸复用）。原文写的是**动态造工具**
 * 的场景（`tmp/tools/<taskId>/`、`tool_created`/`tool_removed` 事件）。
 *
 * 当前 CodeLens 的工具是静态内置（`tools/builtin/` 10 个），**没有动态创建路径**。
 * 按 C1「答不上来的就是装饰」，硬造一套没人调用的动态工具生命周期恰恰违反宣言
 * 自己。所以这里落的是**今天就能打红的等价不变量**：
 *
 *   闸 1 · 孤儿工具闸（静态时代）
 *     目录里的定义必须全部注册、注册表里不得有多余项、名字不得重复。
 *     对应原义「任务作用域必须为空」——不得有声明了却不存在的东西。
 *
 *   闸 2 · 写闸复用
 *     每个进主树的工具必须被至少一个测试引用（未过自证不许进主树）。
 *     这一条会抓真洞：建闸时 `text.diff` 就是 0 测试覆盖。
 *
 *   闸 3 · 动态工具 tripwire（沉淀配对闸的看门狗）
 *     若源码开始写 `tmp/tools/`，则 §6 的三事件与 lesson 配对必须同步存在，
 *     否则红。今天 `tmp/tools/` 不存在，闸为绿；一旦有人加动态工具而不同步
 *     纪律，立刻红——把文档承诺变成机器可对账的不变量。
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUILTIN_TOOLS } from '../src/tools/builtin/index.js';
import { ToolRegistry } from '../src/services/tools/registry.service.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const testsDir = path.join(serverRoot, 'tests');
const srcDir = path.join(serverRoot, 'src');

/** 递归收集目录下的 .ts 文件（跳过 node_modules）。 */
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

function readAll(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const file of collectTsFiles(dir)) out.set(file, readFileSync(file, 'utf8'));
  return out;
}

const testFiles = readAll(testsDir);
const srcFiles = readAll(srcDir);

/**
 * 覆盖扫描必须**排除闸自身**——否则闸的注释里提到工具名就把自己喂饱了，
 * 变成 C3 警告的「永真闸」。建这个闸时第一版就是这样假绿的。
 */
const DISCIPLINE_SELF = 'tool-discipline.test.ts';
const coverageFiles = new Map([...testFiles].filter(([f]) => !f.endsWith(DISCIPLINE_SELF)));

/** 一个工具的可检索标识：wire 名、点名、导出符号名。 */
function identifiersOf(def: { name: string; wireName: string }): string[] {
  const exportGuess = def.name.replace(/\W+(\w)/g, (_m, c: string) => c.toUpperCase()) + 'Tool';
  return [def.name, def.wireName, exportGuess, def.name.replace('.', '_'), def.name.replace('.', '-')];
}

// ─────────────────────────────────────────────────────────────
// 闸 1 · 孤儿工具闸（静态时代）
// ─────────────────────────────────────────────────────────────

describe('闸1 · 孤儿工具闸（静态时代）：目录与注册表必须一致', () => {
  const registry = new ToolRegistry();
  registry.registerAll(BUILTIN_TOOLS);

  it('目录里的每个定义都必须能被注册表取到（不存在声明了却取不到的孤儿）', () => {
    const missing = BUILTIN_TOOLS.filter((d) => registry.get(d.name) === undefined).map((d) => d.name);
    expect(missing, `以下工具在 BUILTIN_TOOLS 里声明但注册表取不到：${missing.join(', ')}`).toEqual([]);
  });

  it('wireName 也必须能反查（上游按 wire 名回传，查不到就是静默丢工具）', () => {
    const missing = BUILTIN_TOOLS.filter((d) => registry.getByWireName(d.wireName) === undefined).map(
      (d) => d.wireName,
    );
    expect(missing, `以下 wireName 反查失败：${missing.join(', ')}`).toEqual([]);
  });

  it('注册表条目数必须等于目录条目数（不存在注册了却没进目录的黑货）', () => {
    expect(registry.list()).toHaveLength(BUILTIN_TOOLS.length);
  });

  it('name 与 wireName 都不得重复（重复会互相覆盖 = 静默丢工具）', () => {
    const names = BUILTIN_TOOLS.map((d) => d.name);
    const wires = BUILTIN_TOOLS.map((d) => d.wireName);
    expect(new Set(names).size, `name 有重复：${names.join(', ')}`).toBe(names.length);
    expect(new Set(wires).size, `wireName 有重复：${wires.join(', ')}`).toBe(wires.length);
  });

  it('每个工具必须声明完整的执行契约字段（缺字段 = 半成品进主树）', () => {
    const incomplete = BUILTIN_TOOLS.filter(
      (d) =>
        !d.name ||
        !d.wireName ||
        !d.description ||
        !d.inputSchema ||
        typeof d.handler !== 'function' ||
        typeof d.maxResultChars !== 'number' ||
        d.maxResultChars <= 0,
    ).map((d) => d.name ?? '(无名)');
    expect(incomplete, `以下工具契约字段不全：${incomplete.join(', ')}`).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 闸 2 · 写闸复用：未过自证不许进主树
// ─────────────────────────────────────────────────────────────

describe('闸2 · 写闸复用：每个进主树的工具必须有测试引用', () => {
  it('每个内置工具都必须被至少一个测试文件引用（覆盖含 name/wireName/导出符号）', () => {
    const uncovered: string[] = [];
    for (const def of BUILTIN_TOOLS) {
      const ids = identifiersOf(def);
      const hit = [...coverageFiles.values()].some((body) => ids.some((id) => body.includes(id)));
      if (!hit) uncovered.push(`${def.name}（应有测试引用 ${ids.join(' / ')} 之一）`);
    }
    expect(
      uncovered,
      `以下工具进了主树却没有任何测试引用，违反「写闸复用：工具要进主树必须过自证」：\n  ${uncovered.join('\n  ')}`,
    ).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// 闸 3 · 动态工具 tripwire（沉淀配对闸的看门狗）
// ─────────────────────────────────────────────────────────────

describe('闸3 · 动态工具 tripwire：出现 tmp/tools 就必须带全套纪律', () => {
  const dynamicToolWrites = [...srcFiles.entries()].filter(([, body]) => body.includes('tmp/tools'));
  const hasLifecycleEvents = [...srcFiles.values()].some(
    (body) => body.includes('tool_created') && body.includes('tool_removed'),
  );
  const hasLessonPairing = [...srcFiles.values()].some((body) => /tool_removed[\s\S]{0,400}lesson|lesson[\s\S]{0,400}tool_removed/.test(body));

  it('源码未出现 tmp/tools 时，闸应为绿（当前状态：静态工具，无动态创建路径）', () => {
    if (dynamicToolWrites.length === 0) {
      expect(dynamicToolWrites).toEqual([]);
      return;
    }
    // 一旦出现动态工具写入，就必须带全套 §6 纪律，否则红
    const missing: string[] = [];
    if (!hasLifecycleEvents) missing.push('tool_created / tool_removed 生命周期事件');
    if (!hasLessonPairing) missing.push('沉淀配对（tool_removed 必须配对一条 lesson）');
    expect(
      missing,
      `源码已开始写 tmp/tools（${dynamicToolWrites.map(([f]) => path.basename(f)).join(', ')}），` +
        `但 §6 纪律缺失：${missing.join('、')}。` +
        `按宣言 §6「只删不沉淀 = 白干」「工具直接进主树不过闸 = 事故」，此处必须补齐。`,
    ).toEqual([]);
  });

  it('tmp/tools 任务作用域目前不得存在（孤儿工具闸：任务结束作用域必须为空）', () => {
    const scope = path.join(serverRoot, 'tmp', 'tools');
    if (existsSync(scope)) {
      // 若真的存在，作用域必须为空，否则就是孤儿工具
      const leftover = readdirSync(scope);
      expect(leftover, `任务作用域 tmp/tools/ 非空，存在孤儿工具：${leftover.join(', ')}`).toEqual([]);
    } else {
      expect(existsSync(scope)).toBe(false);
    }
  });
});
