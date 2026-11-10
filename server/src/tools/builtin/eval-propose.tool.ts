/**
 * eval.propose —— Agent 自己「扩任务空间」的唯一入口。
 *
 * 它提交的不是一句「我觉得该考这个」，而是一份可机械验证的题包：
 *   参考实现 + 带缺陷实现 + 公开用例 + 隐藏用例 + 检索依据。
 *
 * 准入由服务端判定（propose.ts）：参考实现必须自洽全过、缺陷实现必须真的红、
 * 隐藏用例不能是公开用例的复制、**参考实现被变异后用例必须能杀掉变异体**。
 * 只有全过才晋升进测量集；晋升后的套件定义存在沙箱外，Agent 改不到。
 */

import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  promoteProposal,
  validateProposal,
  type EvalProposal,
} from '../../services/eval/propose.js';
import { allSuites, suiteStoreDir } from '../../services/eval/suites.js';
import type { ToolDefinition, ToolOutcome } from '../../types/tool.js';

/** 已晋升套件的上限：防止无上限扩题把测量集稀释成噪声。 */
const MAX_PROMOTED_SUITES = 12;

function proposalStoreDir(sandboxRoot: string): string {
  return path.resolve(sandboxRoot, '..', 'data', 'eval-proposals');
}

function countPromoted(sandboxRoot: string): number {
  try {
    return readdirSync(suiteStoreDir(sandboxRoot)).filter((f) => f.endsWith('.json')).length;
  } catch {
    return 0;
  }
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * 解析用例数组。
 *
 * 刻意接受「JSON 字符串」而不是嵌套对象：部分 OpenAI 兼容网关会把
 * `array of object` 的 schema 判成不支持，进而把整个工具定义丢掉，
 * 表现为「模型只检索、从不调用提案工具」。字符串形式所有网关都认。
 */
function parseCaseList(raw: unknown): EvalProposal['publicCases'] {
  if (!Array.isArray(raw)) return [];
  const out: EvalProposal['publicCases'] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      try {
        const parsed = JSON.parse(item) as EvalProposal['publicCases'][number];
        if (parsed && typeof parsed === 'object') out.push(parsed);
      } catch {
        /* 坏 JSON 直接丢弃，由验证器判红 */
      }
      continue;
    }
    if (item && typeof item === 'object') out.push(item as EvalProposal['publicCases'][number]);
  }
  return out;
}

/** 从工具参数里取字段；类型不对就置空，交给验证器判红。 */
function coerce(raw: unknown): EvalProposal {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return {
    id: asString(o.id),
    title: asString(o.title),
    exportName: asString(o.exportName),
    reference: asString(o.reference),
    buggy: asString(o.buggy),
    publicCases: parseCaseList(o.publicCases),
    hiddenCases: parseCaseList(o.hiddenCases),
    sourceUrls: Array.isArray(o.sourceUrls) ? o.sourceUrls.map((u) => String(u)) : [],
  };
}

export const evalProposeTool: ToolDefinition = {
  name: 'eval.propose',
  wireName: 'eval_propose',
  displayName: '评测提案',
  category: 'compute',
  description:
    '提交一个新的评测套件提案，由服务端做机械验证：参考实现必须全过、缺陷实现必须真的红、' +
    '隐藏用例不能与公开用例重复、参考实现被变异后用例要能杀掉变异体（杀死率 ≥60%）。' +
    '全部通过才会晋升进测量集；否则返回未通过项，可按提示修改后重新提案。' +
    '提案前应先用 web.search 找真实缺陷模式，sourceUrls 填检索结果链接。',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: '小写字母/数字/下划线，3-32 字符，不能与已有套件重名' },
      title: { type: 'string', description: '一句话说明考什么' },
      exportName: { type: 'string', description: '实现文件里导出的函数名' },
      reference: { type: 'string', description: '正确的 CommonJS 实现：module.exports = { 函数名 }' },
      buggy: { type: 'string', description: '同一导出名、但带真实缺陷的实现（会被放进沙箱待修）' },
      publicCases: {
        type: 'array',
        description:
          '至少 2 条。每条是一个 JSON 字符串，形如 {"name":"1..3","args":[1,3],"expected":6}；' +
          '期望抛错时用 {"name":"...","args":[...],"throws":"错误信息子串"}',
        items: { type: 'string' },
      },
      hiddenCases: {
        type: 'array',
        description: '至少 3 条，格式同上；参数不能与 publicCases 相同，要检验通用性',
        items: { type: 'string' },
      },
      sourceUrls: {
        type: 'array',
        description: 'web.search 检索到的链接，至少 1 条',
        items: { type: 'string' },
      },
    },
    required: ['id', 'title', 'exportName', 'reference', 'buggy', 'publicCases', 'hiddenCases', 'sourceUrls'],
    additionalProperties: false,
  },
  timeoutMs: 20000,
  risk: 'medium',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: false,
  maxResultChars: 5000,
  enabled: (ctx) => Boolean(ctx.sandboxRoot),
  handler: async (args, ctx): Promise<ToolOutcome> => {
    const proposal = coerce(args);

    // 上限闸：先判，避免白跑一轮变异验证。
    if (proposal.id && countPromoted(ctx.sandboxRoot) >= MAX_PROMOTED_SUITES) {
      return {
        ok: true,
        summary: `提案未通过：已晋升套件达到上限 ${MAX_PROMOTED_SUITES} 个`,
        data: { accepted: false, checks: [{ name: '套件数量上限', ok: false, detail: '已达上限' }] },
      };
    }

    // 内置 + 已晋升的套件 id 都算占用：晋升后的套件是测量资产，不能被同名提案覆盖。
    const existingIds = allSuites(ctx.sandboxRoot).map((s) => s.id);
    const validation = validateProposal(proposal, existingIds);

    // 审计落盘：无论通过与否都留证，方便复盘「它想考什么、为什么没过」。
    try {
      const dir = proposalStoreDir(ctx.sandboxRoot);
      mkdirSync(dir, { recursive: true });
      const name = proposal.id && /^[a-z0-9_]+$/.test(proposal.id) ? proposal.id : `invalid-${Date.now()}`;
      writeFileSync(
        path.join(dir, `${name}.json`),
        `${JSON.stringify({ ...proposal, validation, at: new Date().toISOString() }, null, 2)}\n`,
        'utf8',
      );
    } catch {
      /* 审计写失败不影响验证结论 */
    }

    let promoted: { implPath: string } | null = null;
    if (validation.accepted) {
      const out = promoteProposal(ctx.sandboxRoot, proposal);
      promoted = { implPath: out.implPath };
    }

    const failed = validation.checks.filter((c) => !c.ok);
    const summary = validation.accepted
      ? `提案通过并已晋升：${proposal.id}（变异杀死率 ${(validation.mutation.score * 100).toFixed(0)}%，待修实现 ${promoted!.implPath}）`
      : `提案未通过：${failed.map((c) => `${c.name}（${c.detail}）`).join('；')}`;

    return {
      ok: true,
      summary,
      data: {
        accepted: validation.accepted,
        checks: validation.checks,
        mutation: validation.mutation,
        promoted,
      },
    };
  },
};
