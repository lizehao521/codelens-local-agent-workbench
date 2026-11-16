/**
 * G1 · 仓库指令文件自动加载（Memory 维破零）。
 *
 * 从沙箱根目录读取 AGENTS.md / CLAUDE.md，将其作为「仓库指令」注入系统提示词。
 * 设计约束：
 *  - 只读沙箱根那一层，不向上查找父目录（防止泄漏沙箱外约定）。
 *  - AGENTS.md 优先于 CLAUDE.md，两者不叠加（避免矛盾约定让模型自行挑选）。
 *  - 超过 8000 字符按字符截断，并在注入块中明确标注「截断」与「fs_read」指路。
 *  - 无文件 / 空串根 / 根不存在 / 目录 / 纯空白 → 返回空串且不抛异常。
 *  - 注入块必须声明从属于基座「硬性规则」，防止不可信仓库内容覆盖安全约束。
 *  - 无第三方依赖，仅使用 node:fs / node:path。
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** 指令文件名清单，顺序即优先级：AGENTS.md > CLAUDE.md。 */
export const INSTRUCTION_FILENAMES = ['AGENTS.md', 'CLAUDE.md'] as const;

/** 单个指令文件注入上限（字符数）。 */
export const MAX_INSTRUCTION_CHARS = 8000;

/** 版本元数据只看文件开头，避免正文里的示例文本被误当成约定版本。 */
const META_WINDOW_CHARS = 4000;
const META_VALUE_MAX_CHARS = 300;

function cleanMeta(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, META_VALUE_MAX_CHARS);
}

/** 支持 HTML 注释标记，也支持人可读的「约定版本：/变更证据：」行。 */
function readMeta(content: string, key: 'version' | 'change'): string {
  const head = content.slice(0, META_WINDOW_CHARS);
  const comment = new RegExp(`<!--\\s*convention-${key}\\s*:\\s*([\\s\\S]*?)-->`, 'i').exec(head)?.[1];
  if (comment) {
    const value = cleanMeta(comment);
    if (value) return value;
  }
  const label = key === 'version' ? '约定版本' : '变更证据';
  const line = new RegExp(`(?:^|\\n)\\s*${label}\\s*[:：]\\s*([^\\n]+)`).exec(head)?.[1];
  return line ? cleanMeta(line) : '';
}

function contentFingerprint(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 从沙箱根目录加载仓库指令文件。
 * @param sandboxRoot 沙箱根目录路径
 * @returns 格式化后的指令文本块，若无有效指令则返回空串
 */
export function loadProjectInstructions(sandboxRoot: string): string {
  // 空串根、根不存在 → 空串不抛
  if (!sandboxRoot || !existsSync(sandboxRoot)) {
    return '';
  }

  // 依次尝试两个文件名，按优先级
  for (const filename of INSTRUCTION_FILENAMES) {
    const filePath = join(sandboxRoot, filename);

    // 不存在、是目录、读取失败 → 继续尝试下一个
    if (!existsSync(filePath)) continue;

    let stat: ReturnType<typeof statSync>;
    try {
      stat = statSync(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    // 纯空白 → 视为无指令
    if (!content.trim()) continue;

    // 截断处理
    let instructionText = content;
    let truncated = false;
    if (content.length > MAX_INSTRUCTION_CHARS) {
      instructionText = content.slice(0, MAX_INSTRUCTION_CHARS);
      truncated = true;
    }

    // 构建注入块：声明从属于「硬性规则」，标注来源文件名、约定版本与变更证据。
    const fingerprint = contentFingerprint(content);
    const explicitVersion = readMeta(content, 'version');
    const explicitChange = readMeta(content, 'change');
    const version = explicitVersion
      ? `${explicitVersion}（内容指纹 sha256:${fingerprint}）`
      : `sha256:${fingerprint}`;
    const evidence = explicitChange
      ? explicitChange
      : `未提供显式变更说明；内容指纹 sha256:${fingerprint}；大小 ${Buffer.byteLength(content, 'utf8')} 字节 / ${content.split(/\r?\n/).length} 行；mtime ${stat.mtime.toISOString()}`;
    const header = `【仓库指令：${filename}】\n约定版本：${version}\n约定生效时间：${stat.mtime.toISOString()}\n变更证据：${evidence}\n以下内容来自仓库根目录的 ${filename}，属于基座「硬性规则」的运行时延伸，优先级低于硬性规则本身。`;
    const footer = truncated
      ? `\n\n[截断：原文超过 ${MAX_INSTRUCTION_CHARS} 字符，已按字符截断。完整内容请用 fs_read 读取 ${filename}。]`
      : '';

    return `${header}\n${instructionText}${footer}`;
  }

  // 两个文件都没有有效内容
  return '';
}
// bridge RSI round: convention version and change evidence verified

// bridge RSI round: convention versioning judge moved to dedicated file

// bridge RSI round: cross-session convention inheritance stores effective time
