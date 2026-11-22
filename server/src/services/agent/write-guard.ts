/**
 * 写闸（write-guard）：异常收尾不自毁的第一道防线。
 *
 * 第三轮 RSI 的失败模式：context_full / circuit_open 收尾时，模型在
 * 上下文见顶的压力下仍然发出 fs.write，写出重复粘贴的函数体、孤立残片，
 * 把 5 个核心文件弄坏，且异常收尾没有自检机会。
 *
 * 本模块提供两条纯规则（无 IO、无状态，可直接单测）：
 *   1. `writeGateFor(occupancy, finishReason)` —— 接近上下文上限或已进入
 *      异常收尾原因时，拒绝新的文件写入，返回显式 NOT_RUN 原因。
 *   2. `firstSyntaxError(src, filePath)` —— 用 TypeScript 解析器做"只解析不执行"
 *      的语法闸，供"写入后自检、失败回滚"复用（与 code.check 同源）。
 *
 * 设计取舍：
 *   - 闸门判定只看 occupancy 与 finishReason，不猜模型意图；宁可误拒一次
 *     写入（模型会收到明确 NOT_RUN 原因并改走其它工具），也不能在见顶
 *     时放行一段可能残缺的内容。
 *   - 语法闸只拦"解析级"错误（残片、重复函数体、未闭合括号），不做类型
 *     检查 —— 类型错误留给写入后的 type_check / 测试，避免把闸门做重。
 */

import ts from 'typescript';

/**
 * 接近上下文上限即落闸的阈值。刻意低于压缩触发线（0.75），留出一轮
 * 缓冲：0.75 以上模型还能正常工作一轮，0.90 以上上下文已基本见顶，
 * 此时再写文件极易产出残片。
 */
export const WRITE_GATE_OCCUPANCY = 0.9;

/** 会触发写闸的异常收尾原因（与 AgentFinishReason 对齐的子集）。 */
export const WRITE_GATE_FINISH_REASONS = new Set([
  'context_full',
  'circuit_open',
  'budget_exhausted',
  'max_iterations',
  'aborted',
  'stream_interrupted',
]);

export interface WriteGateVerdict {
  allowed: boolean;
  /** 拒绝时给模型的明确原因（NOT_RUN 语义），可直接回喂 observation。 */
  reason?: string;
}

/**
 * 判定一次文件写入是否放行。
 *
 * @param occupancy 当前上下文占用率（estimatedTokens / contextWindow，已 clamp）
 * @param finishReason 非空表示 run 已进入该收尾原因（异常收尾路径）
 */
export function writeGateFor(occupancy: number, finishReason?: string | null): WriteGateVerdict {
  if (finishReason && WRITE_GATE_FINISH_REASONS.has(finishReason)) {
    return {
      allowed: false,
      reason: `NOT_RUN：任务已进入收尾原因 ${finishReason}，停止新的文件写入，避免留下半截内容。请改用只读工具盘点现状，或直接输出收尾结论`,
    };
  }
  if (Number.isFinite(occupancy) && occupancy >= WRITE_GATE_OCCUPANCY) {
    return {
      allowed: false,
      reason: `NOT_RUN：上下文占用已达 ${(occupancy * 100).toFixed(1)}%（写闸阈值 ${(WRITE_GATE_OCCUPANCY * 100).toFixed(0)}%），停止新的文件写入，避免残片。请先输出阶段性结论，或改用只读工具`,
    };
  }
  return { allowed: true };
}

export interface SyntaxIssue {
  line: number;
  column: number;
  message: string;
}

function scriptKindForPath(filePath: string): ts.ScriptKind {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  switch (ext) {
    case '.tsx':
      return ts.ScriptKind.TSX;
    case '.mts':
      return ts.ScriptKind.TS;
    case '.cts':
      return ts.ScriptKind.TS;
    case '.ts':
      return ts.ScriptKind.TS;
    default:
      return ts.ScriptKind.Unknown;
  }
}

/**
 * 只解析不执行的语法闸：返回首个 parse diagnostic，无错误返回 null。
 * 与 code.check.tool 的 inspectSyntax 同源，但抽成纯函数供写入后自检复用。
 */
export function firstSyntaxError(src: string, filePath: string): SyntaxIssue | null {
  const sourceFile = ts.createSourceFile(filePath, src, ts.ScriptTarget.Latest, true, scriptKindForPath(filePath));
  const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics;
  const diagnostic = diagnostics?.[0];
  if (!diagnostic) return null;
  const start = diagnostic.start;
  const position = start === undefined ? { line: 0, character: 0 } : sourceFile.getLineAndCharacterOfPosition(start);
  return {
    line: position.line + 1,
    column: position.character + 1,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
  };
}
