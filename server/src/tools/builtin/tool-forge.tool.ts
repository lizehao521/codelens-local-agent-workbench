/**
 * tool.forge —— 让 Agent 在**任务作用域内**造一个自己的工具，并用完回收。
 *
 * 设计对齐 notes/强化Agent.txt §6 工具纪律的 6 步：
 *   1 触发    —— 允许造，但必须在 why_not_existing 里写明「现有工具为何不够」
 *   2 生成    —— 只允许组合既有内置工具（宏），不允许写可执行代码（避免任意代码执行）
 *   3 进沙箱  —— 定义只能落在 tmp/tools/<sessionId>/<name>.json，任务结束即回收
 *   4 使用    —— 每次调用记 tool_used / tool_failed
 *   5 回收    —— recycle 必须回答「沉淀三问」，答不出就不许删
 *   6 回归核心 —— 三问答案被合成为一条 lesson 事件，供 Judge 的配对闸核验
 *
 * 为什么是「宏」而不是生成代码：
 *   · 生成本项目没有代码执行沙箱，跑模型生成的 JS 等于把主机交出去；
 *   · 宏的组合面已经覆盖「把多次调用固化成一次」这个真实需求；
 *   · 宏的每一步都是既有工具，审计口径与主链路完全一致。
 */

import { mkdir, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolDefinition, ToolExecutionContext, ToolOutcome } from '../../types/tool.js';
import { fsReadTool } from './fs-read.tool.js';
import { fsListTool } from './fs-list.tool.js';
import { calcEvaluateTool } from './calc-evaluate.tool.js';
import { jsonFormatTool } from './json-format.tool.js';
import { textDiffTool } from './text-diff.tool.js';
import { timeNowTool } from './time-now.tool.js';
import { uuidGenerateTool } from './uuid-generate.tool.js';

/** 允许被宏调用的工具（读/算类）。刻意排除 sys.exec / http.request / fs.write：
 *  宏是「复用读算能力」，不是「批量执行副作用」的通道。 */
const STEP_TOOLS = [fsReadTool, fsListTool, calcEvaluateTool, jsonFormatTool, textDiffTool, timeNowTool, uuidGenerateTool];

const STEP_BY_WIRE = new Map(STEP_TOOLS.map((t) => [t.wireName, t]));

const OPERATIONS = ['create', 'use', 'recycle'] as const;

/** 工具名：小写字母开头，只允许小写字母/数字/下划线，3-32 位。 */
const NAME_RE = /^[a-z][a-z0-9_]{2,31}$/;

export interface ForgeStep {
  tool: string;
  args: Record<string, unknown>;
}

export interface ForgeSpec {
  name: string;
  description: string;
  why_not_existing: string;
  steps: ForgeStep[];
}

export interface ForgeValidation {
  ok: boolean;
  message: string;
  spec?: ForgeSpec;
}

/**
 * 校验创建请求（纯函数，单测钉死）。
 *
 * 「为什么现有工具不够」至少 8 个字：少于这个长度基本是「因为我想造」，
 * 而这正是纪律要挡的「为一次性问题造工具」。
 */
export function validateForgeSpec(args: Record<string, unknown>): ForgeValidation {
  const name = String(args.name ?? '').trim();
  if (!NAME_RE.test(name)) {
    return { ok: false, message: 'name 必须是 3-32 位小写字母/数字/下划线，且以字母开头' };
  }
  const description = String(args.description ?? '').trim();
  if (description.length < 4) {
    return { ok: false, message: 'description 至少 4 个字，说明这个工具做什么' };
  }
  const why = String(args.why_not_existing ?? '').trim();
  if (why.length < 8) {
    return { ok: false, message: 'why_not_existing 至少 8 个字：现有工具为何不够用' };
  }
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    return { ok: false, message: 'steps 必须是非空数组（1-5 步，每步调用一个既有工具）' };
  }
  if (rawSteps.length > 5) {
    return { ok: false, message: 'steps 最多 5 步：更长的流程应拆成多个宏' };
  }
  const steps: ForgeStep[] = [];
  for (const [i, raw] of rawSteps.entries()) {
    const item = (raw ?? {}) as Record<string, unknown>;
    const tool = String(item.tool ?? '').trim();
    if (!STEP_BY_WIRE.has(tool)) {
      return {
        ok: false,
        message: `第 ${i + 1} 步的 tool="${tool}" 不可用；只允许：${[...STEP_BY_WIRE.keys()].join(', ')}`,
      };
    }
    const stepArgs = item.args;
    if (stepArgs !== undefined && (typeof stepArgs !== 'object' || stepArgs === null || Array.isArray(stepArgs))) {
      return { ok: false, message: `第 ${i + 1} 步的 args 必须是对象` };
    }
    steps.push({ tool, args: (stepArgs as Record<string, unknown>) ?? {} });
  }
  return { ok: true, message: 'ok', spec: { name, description, why_not_existing: why, steps } };
}

/**
 * 把「沉淀三问」的答案合成一条 lesson。
 *
 * 三问对应：解决哪一类问题 / 能否变成 π 的修改 / 下次能不能不造工具就解决。
 * 缺任何一问都不许回收 —— 只删不沉淀等于白干（§6 第 6 步）。
 */
export function composeLesson(
  name: string,
  answers: { category?: unknown; to_pi?: unknown; no_tool_next?: unknown },
): { ok: boolean; message: string; lesson?: string } {
  const category = String(answers.category ?? '').trim();
  const toPi = String(answers.to_pi ?? '').trim();
  const noTool = String(answers.no_tool_next ?? '').trim();
  if (category.length < 4 || toPi.length < 4 || noTool.length < 4) {
    return {
      ok: false,
      message: '沉淀三问必须逐条回答（各至少 4 个字）：category / to_pi / no_tool_next',
    };
  }
  return {
    ok: true,
    message: 'ok',
    lesson: `【动态工具沉淀】${name}：解决「${category}」这类问题；可沉淀为 π 的修改：${toPi}；下次同类问题不造工具即可：${noTool}。`,
  };
}

function scopeDir(ctx: ToolExecutionContext): string {
  return path.join(ctx.sandboxRoot, 'tmp', 'tools', ctx.sessionId);
}

function defPath(ctx: ToolExecutionContext, name: string): string {
  return path.join(scopeDir(ctx), `${name}.json`);
}

async function appendEvent(ctx: ToolExecutionContext, event: string, payload: Record<string, unknown>): Promise<void> {
  const dir = scopeDir(ctx);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify({ ts: Date.now(), event, ...payload })}\n`, 'utf8');
}

/** `{{input}}` 用本次调用传入的 input 替换；`{{prev}}` 用上一步的 summary 替换。 */
function substitute(value: unknown, vars: { input: string; prev: string }): unknown {
  if (typeof value === 'string') {
    return value.replaceAll('{{input}}', vars.input).replaceAll('{{prev}}', vars.prev);
  }
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = substitute(v, vars);
    return out;
  }
  return value;
}

export const toolForgeTool: ToolDefinition = {
  name: 'tool.forge',
  wireName: 'tool_forge',
  displayName: '造/用/回收动态工具',
  category: 'compute',
  description:
    '在任务作用域内创建并使用一个「宏工具」，用完必须回收。operation：' +
    'create（需要 name/description/why_not_existing/steps，steps 只能组合既有读算工具）/ ' +
    'use（执行已创建的工具，可传 input 替换 {{input}}）/ ' +
    'recycle（删除工具，必须用 answers 回答沉淀三问：category/to_pi/no_tool_next）。' +
    '工具只活在 tmp/tools/<sessionId>/ 下，任务结束必须回收；只删不沉淀会被判据塔判为违纪。',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: [...OPERATIONS], description: '操作类型，必填' },
      name: { type: 'string', description: '工具名（小写字母开头，3-32 位）', maxLength: 32 },
      description: { type: 'string', description: 'create：这个工具做什么', maxLength: 300 },
      why_not_existing: { type: 'string', description: 'create：现有工具为何不够用', maxLength: 500 },
      steps: {
        type: 'array',
        description: 'create：步骤数组 [{tool, args}]，tool 取既有工具的 wireName',
      },
      input: { type: 'string', description: 'use：传给宏的输入，替换步骤里的 {{input}}', maxLength: 4000 },
      answers: {
        type: 'object',
        description: 'recycle：沉淀三问 {category, to_pi, no_tool_next}',
      },
    },
    required: ['operation', 'name'],
    additionalProperties: false,
  },
  timeoutMs: 20000,
  risk: 'medium',
  approvalMode: 'soft',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 4000,
  enabled: () => true,

  handler: async (args, ctx): Promise<ToolOutcome> => {
    const operation = String(args.operation ?? '');
    if (!OPERATIONS.includes(operation as (typeof OPERATIONS)[number])) {
      return {
        ok: false,
        summary: `operation 必须是 ${OPERATIONS.join('/')}`,
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'operation 非法' },
      };
    }

    // ── create ────────────────────────────────────────────────────────────
    if (operation === 'create') {
      const v = validateForgeSpec(args);
      if (!v.ok || !v.spec) {
        return {
          ok: false,
          summary: v.message,
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: v.message },
        };
      }
      const file = defPath(ctx, v.spec.name);
      try {
        await readFile(file, 'utf8');
        return {
          ok: false,
          summary: `工具 ${v.spec.name} 已存在；同名工具必须先 recycle 再重建`,
          error: { code: 'TOOL_CONFLICT', kind: 'invalid_args', message: '同名工具已存在' },
        };
      } catch {
        /* 不存在 = 可以创建 */
      }
      await mkdir(scopeDir(ctx), { recursive: true });
      await writeFile(file, `${JSON.stringify(v.spec, null, 2)}\n`, 'utf8');
      await appendEvent(ctx, 'tool_created', {
        name: v.spec.name,
        why: v.spec.why_not_existing,
        steps: v.spec.steps.length,
      });
      return {
        ok: true,
        summary: `已创建动态工具 ${v.spec.name}（${v.spec.steps.length} 步）。下一步用 operation=use 真实调用一次。`,
        data: { name: v.spec.name, path: path.relative(ctx.sandboxRoot, file), steps: v.spec.steps.length },
      };
    }

    const name = String(args.name ?? '').trim();
    if (!NAME_RE.test(name)) {
      return {
        ok: false,
        summary: 'name 非法',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'name 必须是小写字母开头的 3-32 位标识' },
      };
    }
    const file = defPath(ctx, name);
    let spec: ForgeSpec;
    try {
      spec = JSON.parse(await readFile(file, 'utf8')) as ForgeSpec;
    } catch {
      return {
        ok: false,
        summary: `没有名为 ${name} 的动态工具（先 create）`,
        error: { code: 'TOOL_NOT_FOUND', kind: 'not_found', message: `工具 ${name} 不存在` },
      };
    }

    // ── use ───────────────────────────────────────────────────────────────
    if (operation === 'use') {
      const input = String(args.input ?? '');
      let prev = '';
      const summaries: string[] = [];
      for (const [i, step] of spec.steps.entries()) {
        const def = STEP_BY_WIRE.get(step.tool);
        if (!def) {
          await appendEvent(ctx, 'tool_failed', { name, step: i + 1, reason: `unknown_tool:${step.tool}` });
          return {
            ok: false,
            summary: `第 ${i + 1} 步的工具 ${step.tool} 不可用`,
            error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: `unknown step tool ${step.tool}` },
          };
        }
        const stepArgs = substitute(step.args, { input, prev }) as Record<string, unknown>;
        const outcome = await def.handler(stepArgs, ctx);
        if (!outcome.ok) {
          await appendEvent(ctx, 'tool_failed', { name, step: i + 1, reason: outcome.error?.code ?? 'failed' });
          return {
            ok: false,
            summary: `${name} 第 ${i + 1} 步失败：${outcome.summary}`,
            error: outcome.error ?? { code: 'TOOL_STEP_FAILED', kind: 'internal', message: 'step failed' },
          };
        }
        prev = outcome.summary;
        summaries.push(`第 ${i + 1} 步：${outcome.summary}`);
      }
      await appendEvent(ctx, 'tool_used', { name, steps: spec.steps.length });
      return {
        ok: true,
        summary: `${name} 执行成功（${spec.steps.length} 步）：${prev}`.slice(0, 800),
        data: { name, steps: summaries },
      };
    }

    // ── recycle ───────────────────────────────────────────────────────────
    const lesson = composeLesson(name, (args.answers ?? {}) as Record<string, unknown>);
    if (!lesson.ok || !lesson.lesson) {
      return {
        ok: false,
        summary: lesson.message,
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: lesson.message },
      };
    }
    await rm(file, { force: true });
    await appendEvent(ctx, 'tool_removed', { name });
    await appendEvent(ctx, 'lesson', { name, text: lesson.lesson });
    return {
      ok: true,
      summary: `已回收 ${name}，沉淀已记录：${lesson.lesson}`.slice(0, 900),
      data: { name, lesson: lesson.lesson, removed: true },
    };
  },
};
