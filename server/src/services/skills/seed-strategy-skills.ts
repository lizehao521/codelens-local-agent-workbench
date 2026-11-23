/**
 * 内置策略技能的 seed 接线（独立成文件，避免给存量 service 踩行数棘轮）。
 *
 * 只走 SkillLibraryService 的公开面（enabled / get / create），不碰 private repo：
 * 幂等靠「同名已存在则跳过」实现 —— create 本身对同名会抛 409，这里先查后写。
 */

import type { SkillCreateInput } from './skill-library.service.js';
import type { SkillLibraryService } from './skill-library.service.js';

/**
 * 写入 seed 技能（幂等：同名已存在则跳过，重复启动不会重复种子）。
 *
 * - 库未启用时静默返回 0 —— seed 是增强面，关闭时不该制造写入噪声或打断启动；
 * - 单条 seed 校验失败（如命中密钥扫描）跳过该条，不影响其余条与启动流程。
 *
 * @returns 实际新写入的条数。
 */
export function seedSkills(svc: SkillLibraryService, skills: SkillCreateInput[]): number {
  if (!svc.enabled) return 0;
  let inserted = 0;
  for (const skill of skills) {
    const name = typeof skill?.name === 'string' ? skill.name.trim() : '';
    if (!name || svc.get(name)) continue;
    try {
      svc.create(skill);
      inserted += 1;
    } catch {
      // 单条 seed 失败不阻断其余种子与启动（create 已做全部校验并抛明确错误）。
      continue;
    }
  }
  return inserted;
}
