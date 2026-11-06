/**
 * 工作目录上下文。
 *
 * 背景（2026-11-02 实测）：让 Agent 读一个文件回答两个问题，它依次尝试
 * `server/package.json`、`package.json`、`sys.exec find`、以及一段 node 脚本，
 * 10 轮工具调用、68123 prompt token，一个文件都没读到，最终答案是
 * 「任务 token 预算已用尽」。
 *
 * 两个原因，各测一条：
 *   1. system prompt 里没有任何工作目录信息 → 模型只能靠猜路径（本文件第 1、2 条）
 *   2. 默认沙箱根指向 server/sandbox（e2e 测试残留目录）→ 里面只有 drill-r2-* 垃圾
 *
 * 这类缺陷单元测试原本抓不到，因为它不是「工具实现错了」，而是「模型缺少一个事实」。
 */

import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWorkspaceSection } from '../src/services/agent/system-prompt.js';
import { config } from '../src/config/env.js';

describe('buildWorkspaceSection', () => {
  it('写明绝对工作目录，让模型不必猜', () => {
    const section = buildWorkspaceSection('/tmp/ws-root');
    expect(section).toContain('/tmp/ws-root');
    expect(section).toContain('工作目录');
  });

  it('给出可执行的指引，而不只是报一个路径', () => {
    const section = buildWorkspaceSection('/tmp/ws-root');
    // 「不确定就先列一次」是实测中最缺的一句：模型在猜路径时从不先列目录。
    expect(section).toContain('fs_list');
    // 「相对路径相对于它，不要重复拼目录名」直接对应那次 server/server/package.json。
    expect(section).toMatch(/相对路径/);
  });
});

describe('默认工作目录', () => {
  it('不是 e2e/drill 测试占用的 sandbox 目录', () => {
    // 默认值曾指向 path.join(packageRoot, 'sandbox')，而那个目录里全是
    // drill-r2-* / e2e-* 残留：Agent 一进沙箱就看不到任何项目文件。
    const base = path.basename(config.sandboxRoot);
    expect(base).not.toBe('sandbox');
    expect(base).toBe('workspace');
  });
});
