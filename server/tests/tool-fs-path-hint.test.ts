/**
 * R1 回归判据：文件工具的路径语义必须对模型说清楚。
 *
 * 背景：`allowedDirs` 只对绝对路径生效；相对路径永远按沙箱根解析。
 * 之前三个文件工具的 description 都写「必须是沙箱相对路径」，把「可以用绝对路径
 * 访问授权目录」这条能力从模型视野里抹掉了，于是它只会收到「文件不存在」。
 *
 * 这条判据锁的是**模型可见的说明**，不是实现：实现怎么解析由 path-jail 的判据守。
 */

import { describe, expect, it } from 'vitest';
import { fsReadTool } from '../src/tools/builtin/fs-read.tool.js';
import { fsWriteTool } from '../src/tools/builtin/fs-write.tool.js';
import { fsListTool } from '../src/tools/builtin/fs-list.tool.js';

describe('文件工具路径语义（R1）', () => {
  it('三个工具的说明都点明「绝对路径」可用', () => {
    for (const tool of [fsReadTool, fsWriteTool, fsListTool]) {
      expect(tool.description).toContain('绝对路径');
    }
  });

  it('说明里点明相对路径按沙箱根解析，不会去白名单找', () => {
    expect(fsReadTool.description).toContain('按沙箱根解析');
    expect(fsReadTool.description).toContain('不会去白名单里找');
  });
});
