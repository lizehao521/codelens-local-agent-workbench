/**
 * Skills controller — 程序化技能库的 HTTP 视图。
 *
 * 三个端点：
 *  - GET    /skills?q=&limit=&topK=   有 q → 匹配模式；无 q → 列表模式
 *  - POST   /skills                   创建技能
 *  - DELETE /skills/:name             删除技能
 *
 * 分工：控制器只做「取参 + 调 service + 摆响应」；
 * 校验（长度 / 字符集 / 密钥拒绝 / 唯一性）与打分全在 service，
 * 避免同一套规则在两处各写一份、然后慢慢分叉。
 *
 * 响应一律显式构造，不用对象展开：技能内容里可能含用户原文，
 * 展开会让某个未来新增的字段顺带漏出去。
 */

import type { Request, Response } from 'express';
import { z } from 'zod';
import { AppError } from '../utils/errors.js';
import type { SkillLibraryService } from '../services/skills/skill-library.service.js';

/**
 * 请求体形状校验（只管形状：类型与未知字段）。
 * 语义校验（长度上限 / 字符集 / 密钥 / 唯一性）由 service 负责。
 */
const CreateSkillSchema = z
  .object({
    name: z.string(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    steps: z.array(z.string()),
    matchScore: z.number().optional(),
  })
  .strict();

export class SkillsController {
  constructor(private readonly service: SkillLibraryService) {}

  /**
   * 列表 / 匹配（同一个端点，两种模式）。
   *
   * 模式由**参数是否存在**决定，而不是「q 是否为空」：
   * `?q=`（显式给了空查询）走匹配模式并返回空数组 ——
   * 它问的是「匹配空查询」，答案就该是空；退化成全量列表是另一回事。
   */
  list(req: Request, res: Response): void {
    const enabled = this.service.enabled;
    const query = req.query ?? {};

    if (Object.prototype.hasOwnProperty.call(query, 'q')) {
      const text = readString(query.q);
      const topK = readNumber(query.topK);
      const matches = this.service.match(text, topK === undefined ? undefined : topK);
      res.json({ enabled, mode: 'match', query: text, matches });
      return;
    }

    const limit = readNumber(query.limit);
    const skills = this.service.list(limit === undefined ? undefined : limit);
    res.json({ enabled, mode: 'list', skills });
  }

  /** 创建技能。成功返 201（与既有 controller 的创建语义一致）。 */
  create(req: Request, res: Response): void {
    const parsed = CreateSkillSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(
        'VALIDATION_ERROR',
        parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；'),
        400,
      );
    }

    const skill = this.service.create({
      name: parsed.data.name,
      description: parsed.data.description,
      tags: parsed.data.tags,
      steps: parsed.data.steps,
      matchScore: parsed.data.matchScore,
    });

    res.status(201).json({ skill });
  }

  /** 删除技能。不存在返 404（而不是静默成功）。 */
  remove(req: Request, res: Response): void {
    const name = readString(req.params?.name);
    if (!name) {
      throw new AppError('VALIDATION_ERROR', '技能名不能为空', 400);
    }
    if (!this.service.remove(name)) {
      throw new AppError('SKILL_NOT_FOUND', `技能不存在：${name}`, 404);
    }
    res.json({ deleted: true, name });
  }
}

/** 只接受字符串；数组取第一项（?q=a&q=b 这种畸形输入不该 500）。 */
function readString(raw: unknown): string {
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw) && typeof raw[0] === 'string') return raw[0];
  return '';
}

/** 只接受有限数；空串/非法值一律当「未提供」，让 service 用默认值。 */
function readNumber(raw: unknown): number | undefined {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}
