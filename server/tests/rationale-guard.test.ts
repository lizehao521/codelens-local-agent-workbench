/**
 * 「删掉说明动机的注释」闸的判据。
 *
 * 现场：fs-read 的 16KiB 默认值是刻意降下来的，注释里写明了三条理由；
 * 出题 Agent 把它改回 256KiB 的同时删了那几行注释，判据全绿、构建全绿——
 * 因为它把反对自己的证据删了。机械可查的部分就在这里钉住。
 */

import { describe, expect, it } from 'vitest';
import { deletedRationaleComments, isCommentLine } from '../scripts/lib/rationale-guard.mjs';

describe('isCommentLine', () => {
  it('认得行注释与块注释内行', () => {
    expect(isCommentLine('// 原来默认 256 KiB')).toBe(true);
    expect(isCommentLine(' * 256 KiB 在这三条上都是纯浪费')).toBe(true);
    expect(isCommentLine('/* 刻意降低 */')).toBe(true);
    expect(isCommentLine('const DEFAULT_MAX_BYTES = 16384;')).toBe(false);
  });
});

describe('deletedRationaleComments', () => {
  const diff = [
    '--- a/server/src/tools/builtin/fs-read.tool.ts',
    '+++ b/server/src/tools/builtin/fs-read.tool.ts',
    '@@ -6,18 +6,18 @@',
    '- * 原来默认 256 KiB。注意它**不直接决定模型看到多少**',
    '- * 足以卡住渲染）。256 KiB 在这三条上都是纯浪费。',
    '+ * 注意它**不直接决定模型看到多少**',
    '-const DEFAULT_MAX_BYTES = 16384;',
    '+const DEFAULT_MAX_BYTES = 262144;',
  ].join('\n');

  it('抓出被删的动机注释，且忽略代码行与文件头', () => {
    const hits = deletedRationaleComments(diff);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toContain('原来默认 256 KiB');
    expect(hits[1]).toContain('纯浪费');
    // `--- a/...` 不是删除行；`-const ...` 不是注释
    expect(hits.join('\n')).not.toContain('a/server/src');
    expect(hits.join('\n')).not.toContain('DEFAULT_MAX_BYTES');
  });

  it('金丝雀：只删普通描述性注释不算（避免把正常重构全拦住）', () => {
    const trivial = ['- * 默认读取上限。', '- * 单次返回的行数上限。'].join('\n');
    expect(deletedRationaleComments(trivial)).toEqual([]);
  });

  it('新增注释不构成证据销毁', () => {
    const plusOnly = ['+ * 因为要支持大文件，所以调大到 256 KiB'].join('\n');
    expect(deletedRationaleComments(plusOnly)).toEqual([]);
  });

  it('同一行重复出现只报一次（diff 可能分块重复上下文）', () => {
    const dup = ['- * 因为安全原因', '- * 因为安全原因'].join('\n');
    expect(deletedRationaleComments(dup)).toHaveLength(1);
  });
});
