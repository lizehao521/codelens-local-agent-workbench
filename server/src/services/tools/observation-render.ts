/**
 * observation-render — 把工具结果渲染成「喂给模型的那段文本」。
 *
 * 职责边界：只负责序列化与渲染，不写文件、不发事件、不碰数据库。
 * 归档写入仍由 executor 负责，本模块只接收「归档有没有落盘」这个事实。
 */

import { estimateTextTokens } from '../agent/token-estimator.js';

/** 喂给模型的单条工具结果 token 硬顶（含模板前缀与续读提示）。 */
export const OBSERVATION_MAX_TOKENS = 1000;

/** 把文本裁到 token 预算内（estimator 对长度单调，二分找最长前缀）。 */
export function clipToTokenBudget(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTextTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** 工具结果的结构化摘要，用于渲染层判断「怎么把这些数据讲给模型听」。 */
export interface ObservationInput {
  toolName: string;
  summary: string;
  /** 未序列化的原始 payload。 */
  data?: Record<string, unknown>;
  /** 已经序列化的全量结果，用于归档与「被裁掉多少」的计量。 */
  serialized: string;
  /** 归档相对路径；null 表示未归档。 */
  artifactPath: string | null;
  /** 工具自己声明的字符预算。 */
  maxResultChars: number;
  /** 本次调用的原始参数（含 lineStart/lineEnd）。 */
  args?: Record<string, unknown>;
}

/** 序列化 payload。审计链与归档都以这个字符串为准。 */
export function serializeToolData(data: Record<string, unknown> | undefined): string {
  return data === undefined ? '' : JSON.stringify(data);
}

/** 从 args 里取一个正整数行号；缺省或非法返回 undefined。 */
function readPositiveInt(args: Record<string, unknown> | undefined, key: string): number | undefined {
  if (!args) return undefined;
  const raw = args[key];
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

/** 文件类 payload 的形状（fs.read 成功时的 data）。 */
interface FilePayload {
  kind: 'file';
  path: string;
  encoding?: string;
  sizeBytes?: number;
  truncated?: boolean;
  lines?: { returned?: number; total?: number };
  content: string;
}

function asFilePayload(data: Record<string, unknown> | undefined): FilePayload | null {
  if (!data) return null;
  if (data.kind !== 'file') return null;
  if (typeof data.content !== 'string') return null;
  return data as unknown as FilePayload;
}

/**
 * 文件类结果的分行渲染：按行排版、按行裁剪，绝对行号写进正文，
 * 续读提示给的是「本段最后一行 + 1」，可直接作为 fs.read 的 lineStart。
 */
function renderFileObservation(input: ObservationInput, file: FilePayload): string {
  const { toolName, summary, args } = input;

  const startLine = readPositiveInt(args, 'lineStart') ?? 1;

  const rawLines = file.content.split('\n');
  if (rawLines.length > 1 && rawLines[rawLines.length - 1] === '') rawLines.pop();

  const totalLines = file.lines?.total;
  const header = `工具 ${toolName} 执行成功：${summary}\n文件 ${file.path}（第 ${startLine} 行起）`;

  if (rawLines.length === 0) {
    return header;
  }

  const buildNote = (lastLine: number, consumed: number): string => {
    const nextLine = lastLine + 1;
    const totalHint = totalLines !== undefined ? `，全文共 ${totalLines} 行` : '';
    return (
      `\n（结果已截断：本次返回第 ${startLine}-${lastLine} 行，共 ${consumed} 行${totalHint}。` +
      `继续读取请用 fs.read 并传 lineStart=${nextLine}，不要重跑原工具，也不要读 .artifacts 归档）`
    );
  };

  const worstLastLine = startLine + rawLines.length;
  const reserve = estimateTextTokens(buildNote(worstLastLine, rawLines.length));
  const bodyBudget = OBSERVATION_MAX_TOKENS - reserve;

  const body: string[] = [];
  let lastLine = startLine - 1;
  for (let i = 0; i < rawLines.length; i += 1) {
    const lineNo = startLine + i;
    const rendered = `${lineNo}\t${rawLines[i] ?? ''}`;
    const candidate = body.length === 0 ? rendered : `${body.join('\n')}\n${rendered}`;
    const tokens = estimateTextTokens(`${header}\n${candidate}`);
    if (tokens > bodyBudget) break;
    body.push(rendered);
    lastLine = lineNo;
  }

  if (body.length === 0) {
    const prefix = `${header}\n${startLine}\t`;
    const room = Math.max(0, bodyBudget - estimateTextTokens(prefix));
    const piece = clipToTokenBudget(rawLines[0] ?? '', room);
    body.push(`${startLine}\t${piece}`);
    lastLine = startLine;
  }

  const consumed = body.length;
  const moreInPayload = consumed < rawLines.length;
  // 「是否真的还有后续」只看 fs.read 自己给出的截断事实与行数统计，
  // 不按 content 重算总行数（末尾换行会让重算结果偏小，导致小文件被误报截断）。
  const moreInFile =
    file.truncated === true ||
    (totalLines !== undefined && file.lines?.returned !== undefined && file.lines.returned < totalLines);

  if (!moreInPayload && !moreInFile) {
    return `${header}\n${body.join('\n')}`;
  }

  let note = buildNote(lastLine, consumed);
  let text = `${header}\n${body.join('\n')}${note}`;
  while (estimateTextTokens(text) > OBSERVATION_MAX_TOKENS && body.length > 1) {
    body.pop();
    lastLine -= 1;
    note = buildNote(lastLine, body.length);
    text = `${header}\n${body.join('\n')}${note}`;
  }

  return text;
}

/** 渲染模型可见的 observation。 */
export function renderToolObservation(input: ObservationInput): string {
  const { toolName, summary, serialized, artifactPath, maxResultChars, data } = input;

  const file = asFilePayload(data);
  if (file) return renderFileObservation(input, file);

  const charBudget =
    Number.isFinite(maxResultChars) && maxResultChars > 0 ? maxResultChars : Number.POSITIVE_INFINITY;
  const charCapped = serialized.length > charBudget ? serialized.slice(0, charBudget) : serialized;
  const observationData = clipToTokenBudget(charCapped, OBSERVATION_MAX_TOKENS);

  if (!observationData) return `工具 ${toolName} 执行成功：${summary}`;

  const observationClipped = observationData.length < serialized.length;
  const note = observationClipped
    ? artifactPath
      ? `\n（结果已截断：仅返回前段约 ${observationData.length} 字符，完整内容已存 ${artifactPath}，共 ${serialized.length} 字符。需要后续部分请用 fs.read 分段读该文件（配 lineStart/lineEnd 或 keyword 参数），不要重跑原工具）`
      : `\n（结果已截断：仅返回前段约 ${observationData.length} 字符，且归档失败，完整内容不可用；请用更小的范围参数重跑本工具）`
    : '';

  return `工具 ${toolName} 执行成功：${summary}\n结果数据：${observationData}${note}`;
}
