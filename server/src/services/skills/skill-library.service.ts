/**
 * Skill library service — 程序化技能库的写入与检索面。
 *
 * 「程序化技能」= 把一次解题的过程沉淀成可复用的步骤条目：
 *   name（唯一标识）+ description（何时用）+ tags（关键词）+ steps（怎么做）+ matchScore（把握度）。
 *
 * 三条硬约束，缺一不可：
 *  1. **密钥不可入库**：技能内容里出现凭证形态（OpenAI 风格 key、长不透明 token、
 *     键值形态）一律**拒绝写入**，而不是「脱敏后存一份」。
 *     拒绝时的错误信息只说「哪个字段命中哪类模式」，绝不回显原文 ——
 *     错误信息会进日志，回显等于把密钥抄进日志。
 *  2. **参数化校验**：名字/描述/步骤/标签的长度与字符集都有上限，
 *     超限直接拒，不做静默截断（截断会让「我写的」和「存下来的」不一致）。
 *  3. **未启用即空**：技能库由 config.skillLibraryEnabled 控制。
 *     关闭时读接口返回空数组、写接口抛明确错误 —— 不抛未捕获异常，也不假装有数据。
 *
 * 匹配算法刻意保持简单可解释（不引入向量依赖）：
 *   分词（英文/数字按词、中文按字）→ 分档打分 → 低于门槛丢弃 → 按分数降序取 topK。
 *   档位顺序：完全相等 > 标签命中 > 描述包含 > 名称包含。
 *   理由：标签是作者显式挑过的关键词，比「描述里恰好出现」更可信；
 *   名称最短最随意，命中它是最弱的证据。
 *
 * 关于每条技能的 matchScore：它是**该技能自己的把握度声明**，不是匹配门槛。
 * 匹配门槛是全局的 matchMinScore（默认 0.15）；matchScore 只参与同分时的次序比较。
 * 把它当门槛会让默认 0.7 直接盖掉全局门槛，门槛就失去意义了。
 */

import type { Db } from '../../repositories/db.js';
import { SkillRepository, type SkillRow } from '../../repositories/skill.repository.js';
import { AppError } from '../../utils/errors.js';
import { newUuid } from '../../utils/hash.js';

/** 对外暴露的技能定义（领域对象：不含任何 SQL/JSON 细节）。 */
export interface SkillDefinition {
  id: string;
  name: string;
  description: string;
  tags: string[];
  steps: string[];
  matchScore: number;
  createdAt: number;
  updatedAt: number;
}

/** 创建技能的入参。 */
export interface SkillCreateInput {
  name: string;
  description?: string;
  tags?: string[];
  steps: string[];
  matchScore?: number;
}

export interface SkillLibraryOptions {
  db: Db;
  /** 技能库总开关（config.skillLibraryEnabled）。 */
  enabled: boolean;
  /** 低于该相关度的技能不返回。默认 0.15。 */
  matchMinScore?: number;
  /** 单条技能允许的步骤条数上限。默认 12。 */
  maxSteps?: number;
}

// ── 校验上限（集中在此，避免控制器与 service 各写一份口径）──────────────────

export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 512;
export const SKILL_STEP_MAX = 512;
export const SKILL_TAG_MAX = 32;
export const SKILL_TAG_COUNT_MAX = 16;
export const SKILL_DEFAULT_MATCH_SCORE = 0.7;
export const SKILL_DEFAULT_MAX_STEPS = 12;
export const SKILL_DEFAULT_MIN_SCORE = 0.15;
export const SKILL_DEFAULT_TOP_K = 3;
export const SKILL_TOP_K_MAX = 10;
export const SKILL_LIST_LIMIT_DEFAULT = 50;
export const SKILL_LIST_LIMIT_MAX = 200;
/** 匹配时最多扫描多少条技能：技能库是人工维护的小集合，但要有个硬上限兜底。 */
export const SKILL_MATCH_SCAN_MAX = 500;

/** 技能名允许的字符：字母 / 数字 / 连字符 / 下划线 / 点 / 中文。 */
const SKILL_NAME_RE = /^[A-Za-z0-9_\-.\u4e00-\u9fff]+$/;

/**
 * 密钥形态模式表。
 *
 * 顺序即优先级：命中第一条就报错，因此报出来的是最具体的那一类。
 * 刻意不用带 `g` 的正则 —— 带 g 的正则有 lastIndex 状态，重复 test 会漏判。
 */
export interface SecretPattern {
  id: string;
  label: string;
  re: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  // OpenAI 风格密钥前缀（sk-…）。
  { id: 'openai_style_key', label: 'OpenAI 风格密钥前缀', re: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  // 长不透明 token：不含分隔符的 32 位以上随机串（哈希、base64、随机口令）。
  { id: 'opaque_token', label: '长不透明 token', re: /\b[A-Za-z0-9_-]{32,}\b/ },
  // 键值形态：api_key / apikey / api-key / secret / token / password 后面跟 : 或 =。
  { id: 'key_value_pair', label: '键值形态凭证', re: /\b(?:api[_-]?key|secret|token|password)\s*[:=]\s*\S+/i },
];

// ── 打分档位（完全相等 > 标签命中 > 描述包含 > 名称包含）─────────────────────

/** 完全相等：query 与 name 归一后相同。 */
const TIER_EXACT = 1;
/** 标签命中：query 与某个 tag 相同，或 query 的全部词都落在 tags 上。 */
const TIER_TAG = 0.8;
/** 描述包含：description 包含 query，或 query 的全部词都落在 description 上。 */
const TIER_DESCRIPTION = 0.6;
/** 名称包含：name 包含 query，或 query 的全部词都落在 name 上。 */
const TIER_NAME = 0.45;
/** 跨字段部分命中的上限：低于任何完整档位，只用于给出「弱相关」的次序。 */
const PARTIAL_CEILING = 0.4;
/** 同档内部用于区分先后的覆盖度加成上限（不跨档，故不破坏档位顺序）。 */
const COVERAGE_BONUS = 0.1;

export class SkillLibraryService {
  private readonly repo: SkillRepository;
  private readonly libraryEnabled: boolean;
  private readonly matchMinScore: number;
  private readonly maxSteps: number;

  constructor(opts: SkillLibraryOptions) {
    this.repo = new SkillRepository(opts.db);
    this.libraryEnabled = opts.enabled === true;
    this.matchMinScore = clampScore(opts.matchMinScore, SKILL_DEFAULT_MIN_SCORE);
    // 非有限数（NaN / Infinity）一律回落默认值：NaN 参与比较恒为 false，
    // 若直接用会让「条数上限」这条校验形同虚设。
    this.maxSteps =
      typeof opts.maxSteps === 'number' && Number.isFinite(opts.maxSteps)
        ? Math.max(1, Math.trunc(opts.maxSteps))
        : SKILL_DEFAULT_MAX_STEPS;
  }

  /** 技能库是否启用（控制器要把它回给前端，前端据此显示「未启用」）。 */
  get enabled(): boolean {
    return this.libraryEnabled;
  }

  /** 列表（最近更新的在前）。未启用时返回空数组。 */
  list(limit?: number): SkillDefinition[] {
    if (!this.libraryEnabled) return [];
    return this.repo.list(clampLimit(limit)).map(toDefinition);
  }

  /** 按 name 取一条。未启用时返回 undefined（视作空库）。 */
  get(name: string): SkillDefinition | undefined {
    if (!this.libraryEnabled) return undefined;
    const key = typeof name === 'string' ? name.trim() : '';
    if (!key) return undefined;
    const row = this.repo.getByName(key);
    return row ? toDefinition(row) : undefined;
  }

  /**
   * 创建一条技能。
   *
   * 失败一律抛 AppError（明确错误码 + 中文原因），不吞异常、不静默覆盖同名技能。
   */
  create(input: SkillCreateInput): SkillDefinition {
    this.assertEnabled();

    const name = validateName(input?.name);
    const description = validateDescription(input?.description);
    const tags = validateTags(input?.tags);
    const steps = validateSteps(input?.steps, this.maxSteps);
    const matchScore = validateMatchScore(input?.matchScore);

    // 密钥扫描放在结构校验之后：结构都不合法时，先说清楚哪条结构不合法。
    this.assertNoSecret('name', name);
    this.assertNoSecret('description', description);
    tags.forEach((tag, i) => this.assertNoSecret(`tags[${i}]`, tag));
    steps.forEach((step, i) => this.assertNoSecret(`steps[${i}]`, step));

    if (this.repo.getByName(name)) {
      throw new AppError('SKILL_ALREADY_EXISTS', `技能名已存在：${name}`, 409);
    }

    const now = Date.now();
    const id = newUuid();
    try {
      this.repo.insert({
        id,
        name,
        description,
        tagsJson: JSON.stringify(tags),
        stepsJson: JSON.stringify(steps),
        matchScore,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      // 并发下同名双写：UNIQUE 索引兜底（错误信息里只有名字，名字已被字符集限制过）。
      if (isUniqueViolation(err)) {
        throw new AppError('SKILL_ALREADY_EXISTS', `技能名已存在：${name}`, 409);
      }
      throw err;
    }

    return { id, name, description, tags, steps, matchScore, createdAt: now, updatedAt: now };
  }

  /**
   * 删除一条技能。
   *
   * @returns true = 删掉了；false = 本来就没有（调用方据此返 404）。
   */
  remove(name: string): boolean {
    this.assertEnabled();
    const key = typeof name === 'string' ? name.trim() : '';
    if (!key) throw new AppError('VALIDATION_ERROR', '技能名不能为空', 400);
    return this.repo.deleteByName(key) === 1;
  }

  /**
   * 按 query 检索技能，按相关度降序取前 topK 条。
   *
   * - 未启用 → 空数组；
   * - query 为空串 → 空数组（**不退化成全量列表**：那是两回事）；
   * - 得分低于 matchMinScore → 不返回；
   * - topK 越界 → 截断到 [1, 10]。
   */
  match(query: string, topK?: number): SkillDefinition[] {
    if (!this.libraryEnabled) return [];
    const text = typeof query === 'string' ? query.trim() : '';
    if (!text) return [];

    const tokens = tokenize(text);
    if (tokens.length === 0) return [];

    const k = clampTopK(topK);
    const rows = this.repo.list(SKILL_MATCH_SCAN_MAX);

    const scored = rows
      .map((row) => {
        const skill = toDefinition(row);
        return { skill, score: scoreSkill(skill, text, tokens) };
      })
      .filter((item) => item.score >= this.matchMinScore);

    // 同分时先看技能自己的把握度声明，再按名字定序 —— 保证结果稳定可复现。
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        b.skill.matchScore - a.skill.matchScore ||
        a.skill.name.localeCompare(b.skill.name),
    );

    return scored.slice(0, k).map((item) => item.skill);
  }

  /** 未启用时写操作一律拒绝，且给出可操作的原因。 */
  private assertEnabled(): void {
    if (!this.libraryEnabled) {
      throw new AppError(
        'SKILL_LIBRARY_DISABLED',
        '技能库未启用：请先开启 SKILL_LIBRARY_ENABLED 再写入技能',
        409,
      );
    }
  }

  /**
   * 密钥扫描：命中即拒。
   *
   * 错误信息里只有「字段 + 模式类别」，没有命中的原文 ——
   * 错误信息会被日志与前端拿到，回显原文等于二次泄漏。
   */
  private assertNoSecret(field: string, value: string): void {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.re.test(value)) {
        throw new AppError(
          'SKILL_SECRET_DETECTED',
          `字段 ${field} 命中密钥模式「${pattern.label}」，疑似凭证，已拒绝入库（不回显原文）`,
          400,
        );
      }
    }
  }
}

// ── 校验 ───────────────────────────────────────────────────────────────────

function validateName(raw: unknown): string {
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'name 必须是字符串', 400);
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'name 不能为空', 400);
  }
  if (name.length > SKILL_NAME_MAX) {
    throw new AppError('VALIDATION_ERROR', `name 长度不能超过 ${SKILL_NAME_MAX} 个字符`, 400);
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new AppError(
      'VALIDATION_ERROR',
      'name 只能包含字母、数字、连字符、下划线、点与中文（不含空白与路径分隔符）',
      400,
    );
  }
  return name;
}

function validateDescription(raw: unknown): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    throw new AppError('VALIDATION_ERROR', 'description 必须是字符串', 400);
  }
  const description = raw.trim();
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new AppError(
      'VALIDATION_ERROR',
      `description 长度不能超过 ${SKILL_DESCRIPTION_MAX} 个字符`,
      400,
    );
  }
  return description;
}

function validateTags(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'tags 必须是数组', 400);
  }
  if (raw.length > SKILL_TAG_COUNT_MAX) {
    throw new AppError('VALIDATION_ERROR', `tags 最多 ${SKILL_TAG_COUNT_MAX} 项`, 400);
  }
  const tags: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new AppError('VALIDATION_ERROR', 'tags 每一项都必须是字符串', 400);
    }
    const tag = item.trim();
    if (tag.length === 0) continue; // 空标签没有信息量，丢弃而不是占名额。
    if (tag.length > SKILL_TAG_MAX) {
      throw new AppError('VALIDATION_ERROR', `tags 每一项长度不能超过 ${SKILL_TAG_MAX} 个字符`, 400);
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  return tags;
}

function validateSteps(raw: unknown, maxSteps: number): string[] {
  if (!Array.isArray(raw)) {
    throw new AppError('VALIDATION_ERROR', 'steps 必须是数组', 400);
  }
  if (raw.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'steps 至少要有 1 条', 400);
  }
  if (raw.length > maxSteps) {
    throw new AppError('VALIDATION_ERROR', `steps 最多 ${maxSteps} 条`, 400);
  }
  const steps: string[] = [];
  raw.forEach((item, index) => {
    if (typeof item !== 'string') {
      throw new AppError('VALIDATION_ERROR', `steps[${index}] 必须是字符串`, 400);
    }
    const step = item.trim();
    if (step.length === 0) {
      throw new AppError('VALIDATION_ERROR', `steps[${index}] 不能为空`, 400);
    }
    if (step.length > SKILL_STEP_MAX) {
      throw new AppError(
        'VALIDATION_ERROR',
        `steps[${index}] 长度不能超过 ${SKILL_STEP_MAX} 个字符`,
        400,
      );
    }
    steps.push(step);
  });
  return steps;
}

function validateMatchScore(raw: unknown): number {
  if (raw === undefined || raw === null) return SKILL_DEFAULT_MATCH_SCORE;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new AppError('VALIDATION_ERROR', 'matchScore 必须是 0~1 之间的有限数', 400);
  }
  if (raw < 0 || raw > 1) {
    throw new AppError('VALIDATION_ERROR', 'matchScore 必须在 0~1 之间', 400);
  }
  return raw;
}

// ── 打分 ───────────────────────────────────────────────────────────────────

/**
 * 相关度打分（0~1）。
 *
 * 档位（取命中的最高档）：
 *   1.00  name 与 query 完全相等
 *   0.80  标签命中（query 等于某个 tag，或 query 的全部词都落在 tags 上）
 *   0.60  描述包含（description 含 query，或 query 的全部词都落在 description 上）
 *   0.45  名称包含（name 含 query，或 query 的全部词都落在 name 上）
 *   跨字段部分命中：覆盖率 × 0.40（弱于任何完整档位）
 *
 * 同档内部用「query 词被命中的比例」做最多 +0.10 的加成，
 * 加成不足以跨档，故「完全相等 > 标签 > 描述 > 名称」的顺序永远成立。
 */
function scoreSkill(skill: SkillDefinition, query: string, tokens: string[]): number {
  const queryNorm = normalize(query);
  const nameNorm = normalize(skill.name);
  const descNorm = normalize(skill.description);
  const tagNorms = skill.tags.map((tag) => normalize(tag));

  const nameTokens = new Set(tokenize(skill.name));
  const tagTokens = new Set(skill.tags.flatMap((tag) => tokenize(tag)));
  const descTokens = new Set(tokenize(skill.description));

  let base = 0;
  if (queryNorm.length > 0 && nameNorm === queryNorm) {
    base = TIER_EXACT;
  } else if (tagNorms.includes(queryNorm) || allTokensIn(tokens, tagTokens)) {
    base = TIER_TAG;
  } else if (descNorm.includes(queryNorm) || allTokensIn(tokens, descTokens)) {
    base = TIER_DESCRIPTION;
  } else if (nameNorm.includes(queryNorm) || allTokensIn(tokens, nameTokens)) {
    base = TIER_NAME;
  }

  const coverage = coverageOf(tokens, [nameTokens, tagTokens, descTokens]);
  const score = base === 0 ? coverage * PARTIAL_CEILING : base + COVERAGE_BONUS * coverage;
  return Math.min(1, Math.round(score * 10000) / 10000);
}

/** query 的每个词是否都出现在给定的词集合里（集合是多个字段的并集）。 */
function allTokensIn(tokens: string[], target: Set<string>): boolean {
  return tokens.every((token) => target.has(token));
}

/** query 的词被命中的比例（出现在任一字段即算命中）。 */
function coverageOf(tokens: string[], targets: Set<string>[]): number {
  if (tokens.length === 0) return 0;
  const hit = tokens.filter((token) => targets.some((target) => target.has(token))).length;
  return hit / tokens.length;
}

/**
 * 分词：英文/数字按词切，中文按字切。
 *
 * 刻意不引入分词器或向量依赖 —— 技能库是人工维护的小集合，
 * 可解释的粗粒度分词足够，且零额外依赖。
 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const tokens: string[] = [];
  for (const m of lower.matchAll(/[a-z0-9]+/g)) {
    const token = m[0];
    if (token) tokens.push(token);
  }
  for (const m of lower.matchAll(/[\u4e00-\u9fff]/g)) {
    const token = m[0];
    if (token) tokens.push(token);
  }
  return tokens;
}

/** 归一：小写 + 去首尾空白 + 折叠连续空白。 */
function normalize(text: string): string {
  return text.toLowerCase().trim().replace(/\s+/g, ' ');
}

// ── 边界工具 ───────────────────────────────────────────────────────────────

function clampLimit(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SKILL_LIST_LIMIT_DEFAULT;
  const limit = Math.trunc(raw);
  if (limit < 1) return 1;
  if (limit > SKILL_LIST_LIMIT_MAX) return SKILL_LIST_LIMIT_MAX;
  return limit;
}

function clampTopK(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return SKILL_DEFAULT_TOP_K;
  const k = Math.trunc(raw);
  if (k < 1) return 1;
  if (k > SKILL_TOP_K_MAX) return SKILL_TOP_K_MAX;
  return k;
}

function clampScore(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback;
  return Math.min(1, Math.max(0, raw));
}

/** SQLite 的 UNIQUE 冲突（并发双写同名技能时兜底）。 */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

// ── 行 → 领域对象 ──────────────────────────────────────────────────────────

function toDefinition(row: SkillRow): SkillDefinition {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    tags: parseStringArray(row.tags_json),
    steps: parseStringArray(row.steps_json),
    matchScore: row.match_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 容错解析 JSON 数组：坏数据退化成空数组，不让一条脏行打断整个列表。 */
function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}
