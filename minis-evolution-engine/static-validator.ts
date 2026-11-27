/**
 * 静态校验管线 - 语法、类型、契约、文件大小、命名规范、禁止模式
 * 输出：{ok: boolean, issues: StaticIssue[], summary}
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { StaticValidationResult, StaticIssue, Severity, EvolutionEngineConfig } from './types.js';

// ========== 禁止模式正则 ==========

const FORBIDDEN_PATTERNS: { regex: RegExp; code: string; message: string }[] = [
  { regex: /\beval\s*\(/, code: 'FORBIDDEN_EVAL', message: '禁止使用 eval()' },
  { regex: /\bFunction\s*\(/, code: 'FORBIDDEN_FUNCTION_CTOR', message: '禁止使用 Function 构造器' },
  { regex: /\bnew\s+Function\s*\(/, code: 'FORBIDDEN_NEW_FUNCTION', message: '禁止使用 new Function()' },
  { regex: /\brequire\s*\(\s*['"`][^'"`]*['"`]\s*\)/, code: 'FORBIDDEN_DYNAMIC_REQUIRE', message: '禁止动态 require()' },
  { regex: /\bimport\s*\(\s*['"`][^'"`]*['"`]\s*\)/, code: 'FORBIDDEN_DYNAMIC_IMPORT', message: '禁止动态 import()' },
  { regex: /\bglobalThis\b/, code: 'FORBIDDEN_GLOBAL_THIS', message: '禁止使用 globalThis' },
  { regex: /\bprocess\.(env|exit|kill)/, code: 'FORBIDDEN_PROCESS', message: '禁止直接操作 process.env/exit/kill' },
  { regex: /\bchild_process\b/, code: 'FORBIDDEN_CHILD_PROCESS', message: '禁止使用 child_process' },
  { regex: /\bfs\.(write|read|unlink|rm|mkdir)/, code: 'FORBIDDEN_FS_DIRECT', message: '禁止直接文件系统操作' },
  { regex: /\bnet\./, code: 'FORBIDDEN_NET', message: '禁止使用 net 模块' },
  { regex: /\bhttp\./, code: 'FORBIDDEN_HTTP', message: '禁止直接使用 http 模块' },
  { regex: /\bhttps\./, code: 'FORBIDDEN_HTTPS', message: '禁止直接使用 https 模块' },
];

// ========== 命名规范检查 ==========

function checkNamingConvention(filePath: string, content: string): StaticIssue[] {
  const issues: StaticIssue[] = [];
  const lines = content.split('\n');

  // 文件名：kebab-case
  const fileName = path.basename(filePath);
  if (!/^[a-z0-9]+(-[a-z0-9]+)*\.(ts|tsx)$/.test(fileName) && !fileName.includes('.test.')) {
    issues.push({
      file: filePath,
      line: 1,
      column: 1,
      code: 'NAMING_FILE_KEBAB_CASE',
      message: `文件名应为 kebab-case: ${fileName}`,
      severity: 'warning',
      ruleId: 'naming-convention',
    });
  }

  // 导出的类/接口：PascalCase
  // 导出的函数/变量：camelCase
  // 常量：UPPER_SNAKE_CASE
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const exportMatch = line.match(/^export\s+(?:const|function|class|interface|type)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
    if (exportMatch) {
      const name = exportMatch[1];
      if (/^[A-Z][A-Za-z0-9]*$/.test(name)) {
        // PascalCase - 类/接口/类型，OK
      } else if (/^[a-z][a-zA-Z0-9]*$/.test(name)) {
        // camelCase - 函数/变量，OK
      } else if (/^[A-Z_][A-Z0-9_]*$/.test(name)) {
        // UPPER_SNAKE_CASE - 常量，OK
      } else {
        issues.push({
          file: filePath,
          line: i + 1,
          column: exportMatch.index ?? 0,
          code: 'NAMING_EXPORT_CONVENTION',
          message: `导出名称不符合规范: ${name}`,
          severity: 'warning',
          ruleId: 'naming-convention',
        });
      }
    }
  }

  return issues;
}

// ========== 文件大小检查 ==========

function checkFileSize(filePath: string, maxLines: number): StaticIssue[] {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n').length;
  if (lines > maxLines) {
    return [{
      file: filePath,
      line: maxLines,
      column: 1,
      code: 'FILE_SIZE_EXCEEDED',
      message: `文件 ${lines} 行超过上限 ${maxLines} 行`,
      severity: 'error',
      ruleId: 'file-size',
    }];
  }
  return [];
}

// ========== 单文件校验 ==========

export interface ValidationContext {
  config: EvolutionEngineConfig['staticValidation'];
  projectRoot: string;
}

export async function validateFile(
  filePath: string,
  context: ValidationContext
): Promise<StaticIssue[]> {
  const issues: StaticIssue[] = [];

  if (!existsSync(filePath)) {
    return [{
      file: filePath,
      line: 1,
      column: 1,
      code: 'FILE_NOT_FOUND',
      message: '文件不存在',
      severity: 'error',
    }];
  }

  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');

  // 1. 禁止模式
  for (const { regex, code, message } of FORBIDDEN_PATTERNS) {
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(regex);
      if (match) {
        issues.push({
          file: filePath,
          line: i + 1,
          column: match.index ?? 0,
          code,
          message,
          severity: 'error',
          ruleId: 'forbidden-pattern',
        });
      }
    }
  }

  // 2. 命名规范
  issues.push(...checkNamingConvention(filePath, content));

  // 3. 文件大小
  issues.push(...checkFileSize(filePath, context.config.maxFileLines));

  return issues;
}

// ========== TypeScript 编译/类型检查 ==========

export async function runTypeCheck(projectRoot: string): Promise<StaticIssue[]> {
  const issues: StaticIssue[] = [];
  try {
    execFileSync('npx', ['tsc', '--noEmit', '--strict'], {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: 120_000,
    });
  } catch (e) {
    const output = e instanceof Error ? e.message : String(e);
    // 解析 tsc 输出
    const lines = output.split('\n');
    for (const line of lines) {
      const match = line.match(/^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/);
      if (match) {
        const [, file, lineStr, colStr, severity, code, message] = match;
        issues.push({
          file: path.resolve(projectRoot, file),
          line: parseInt(lineStr, 10),
          column: parseInt(colStr, 10),
          code,
          message: message.trim(),
          severity: severity === 'error' ? 'error' : 'warning',
          ruleId: 'typescript',
        });
      }
    }
  }
  return issues;
}

// ========== 契约校验（Zod schema / API 契约） ==========

export async function validateContracts(projectRoot: string): Promise<StaticIssue[]> {
  // TODO: 扫描 validators/ 目录下的 schema 并验证
  // 暂时返回空，后续可扩展为运行现有的 check:task-metadata 等脚本
  return [];
}

// ========== 全量校验入口 ==========

export async function runStaticValidation(
  targetFiles: string[],
  context: ValidationContext
): Promise<StaticValidationResult> {
  const allIssues: StaticIssue[] = [];

  // 1. TypeScript 类型检查（全量）
  const tsIssues = await runTypeCheck(context.projectRoot);
  allIssues.push(...tsIssues);

  // 2. 单文件规则（目标文件 + 关联文件）
  for (const file of targetFiles) {
    const fileIssues = await validateFile(file, context);
    allIssues.push(...fileIssues);
  }

  // 3. 契约校验
  const contractIssues = await validateContracts(context.projectRoot);
  allIssues.push(...contractIssues);

  // 统计
  const summary = {
    errors: allIssues.filter(i => i.severity === 'error').length,
    warnings: allIssues.filter(i => i.severity === 'warning').length,
    infos: allIssues.filter(i => i.severity === 'info').length,
  };

  return {
    ok: summary.errors === 0,
    issues: allIssues,
    summary,
  };
}

// ========== 便捷函数：仅校验单个提案涉及的文件 ==========

export async function validateProposalFiles(
  proposalFiles: string[],
  projectRoot: string,
  config: EvolutionEngineConfig['staticValidation']
): Promise<StaticValidationResult> {
  return runStaticValidation(proposalFiles, { config, projectRoot });
}