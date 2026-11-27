import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext, ToolOutcome } from '../../types/tool.js';
import type { ForgeSpec } from './tool-forge.tool.js';
import { generateTests } from './tool-forge-test-gen.js';

/** bumpVersion: semantic version increment */
function bumpVersion(current: string, type: 'major' | 'minor' | 'patch'): string {
  const parts = current.split('.').map((p) => parseInt(p, 10) || 0);
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (type === 'major') return (major + 1) + '.0.0';
  if (type === 'minor') return major + '.' + (minor + 1) + '.0';
  return major + '.' + minor + '.' + (patch + 1);
}

/** determineBumpType: infer bump type from references content */
function determineBumpType(references: Array<{ title: string; url: string }>): 'major' | 'minor' | 'patch' {
  const joined = references.map((r) => r.title + ' ' + r.url).join(' ').toLowerCase();
  if (joined.includes('breaking')) return 'major';
  if (joined.includes('new') || joined.includes('feature')) return 'minor';
  return 'patch';
}

/** generateChangelogEntry: produce a changelog block */
function generateChangelogEntry(name: string, version: string, spec: ForgeSpec, bumpType: string): string {
  const date = new Date().toISOString().split('T')[0];
  return [
    '## [' + version + '] - ' + date,
    '### ' + name,
    '- ' + spec.description,
    '- steps: ' + spec.steps.map((s) => s.tool).join(', '),
    '- bump: ' + bumpType,
    '',
  ].join('\n');
}

/** versionFilePath: per-tool version file */
function versionFilePath(ctx: ToolExecutionContext, name: string): string {
  return path.join(libraryDir(ctx), name + '.version.json');
}

/** changelogFilePath: single library changelog */
function changelogFilePath(ctx: ToolExecutionContext): string {
  return path.join(libraryDir(ctx), 'CHANGELOG.md');
}

/** readCurrentVersion: read a tool version (default 0.0.0) */
async function readCurrentVersion(ctx: ToolExecutionContext, name: string): Promise<string> {
  try {
    const raw = await readFile(versionFilePath(ctx, name), 'utf8');
    const data = JSON.parse(raw) as { version?: string };
    return data.version || '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/** writeVersionFile: persist version metadata */
async function writeVersionFile(ctx: ToolExecutionContext, name: string, version: string, promotedAt: string): Promise<void> {
  const payload = JSON.stringify({ version, promotedAt }, null, 2);
  await writeFile(versionFilePath(ctx, name), payload, 'utf8');
}

function scopeDir(ctx: ToolExecutionContext): string {
  return path.join(ctx.sandboxRoot, 'tmp', 'tools', ctx.sessionId);
}

/**
 * 会话级能力库 —— 沉淀下来的能力放这里。
 *
 * 与任务作用域的区别（这是「沉淀」能成立的关键）：
 *   · tmp/tools/<session>/  是**义肢**：任务结束必须回收，否则孤儿闸判红；
 *   · .codelens/tool-library/<session>/ 是**记忆**：recycle 时选择晋升才写入，
 *     下一代可以直接 use，不必重建。读本 §6 第 6 步「把答案写回 π / 记忆」
 *     在机器侧就落在这一层。
 */
function libraryDir(ctx: ToolExecutionContext): string {
  return path.join(ctx.sandboxRoot, '.codelens', 'tool-library', ctx.sessionId);
}

function defPath(ctx: ToolExecutionContext, name: string): string {
  return path.join(scopeDir(ctx), `${name}.json`);
}

function libraryPath(ctx: ToolExecutionContext, name: string): string {
  return path.join(libraryDir(ctx), `${name}.json`);
}

async function appendEvent(ctx: ToolExecutionContext, event: string, payload: Record<string, unknown>): Promise<void> {
  const dir = scopeDir(ctx);
  await mkdir(dir, { recursive: true });
  await appendFile(path.join(dir, 'events.jsonl'), `${JSON.stringify({ ts: Date.now(), event, ...payload })}\n`, 'utf8');
}

/** runPromotion: full promotion flow (generate tests -> gate -> versioning -> library) */
async function runPromotion(
  ctx: ToolExecutionContext,
  name: string,
  spec: ForgeSpec,
): Promise<{ ok: true; promoted: boolean; nextVersion: string } | { ok: false; outcome: ToolOutcome }> {
  try {
    // 1. 自动生成测试
    const testCode = generateTests(spec);
    const testDir = path.join(ctx.sandboxRoot, 'tests', 'tools');
    await mkdir(testDir, { recursive: true });
    const testPath = path.join(testDir, name + '.test.ts');
    await writeFile(testPath, testCode, 'utf8');

    // 2. 强制跑测试：仅有 package.json 的项目沙箱才执行门禁
    let hasPackageJson = false;
    try {
      await readFile(path.join(ctx.sandboxRoot, 'package.json'), 'utf8');
      hasPackageJson = true;
    } catch {
      hasPackageJson = false;
    }
    if (hasPackageJson) {
      try {
        const { execSync } = await import('node:child_process');
        execSync('npx vitest run ' + testPath, {
          cwd: ctx.sandboxRoot,
          stdio: 'pipe',
          timeout: 60000,
        });
      } catch (testError) {
        await rm(testPath, { force: true });
        await appendEvent(ctx, 'tool_promote_test_failed', { name });
        return {
          ok: false,
          outcome: {
            ok: false,
            summary: '晋升失败：自动生成的测试未通过（' + String(testError).slice(0, 200) + '）',
            error: { code: 'TOOL_PROMOTE_TEST_FAILED', kind: 'internal', message: 'generated test failed' },
          },
        };
      }
    }

    // 3. 版本化
    const current = await readCurrentVersion(ctx, name);
    const bumpType = determineBumpType(spec.references);
    const nextVersion = bumpVersion(current, bumpType);

    // 4. changelog 与版本文件
    await mkdir(libraryDir(ctx), { recursive: true });
    await writeFile(changelogFilePath(ctx), generateChangelogEntry(name, nextVersion, spec, bumpType), 'utf8');
    await writeVersionFile(ctx, name, nextVersion, new Date().toISOString());

    // 5. 晋升到能力库
    await writeFile(libraryPath(ctx, name), `${JSON.stringify(spec, null, 2)}\n`, 'utf8');
    await appendEvent(ctx, 'tool_promoted', { name, version: nextVersion });
    return { ok: true, promoted: true, nextVersion };
  } catch {
    return { ok: true, promoted: false, nextVersion: '' };
  }
}

export { scopeDir, libraryDir, defPath, libraryPath, appendEvent, runPromotion };
