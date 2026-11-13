import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveAuthorModel, askAuthor, type Proposal } from '../scripts/author-task.js';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const SERVER = process.cwd();
const SERVER_ENV_PATH = join(SERVER, '.env');
const HAS_SERVER_ENV = existsSync(SERVER_ENV_PATH);

describe('resolveAuthorModel（出题人模型解析）', () => {
  it('环境变量 RSI_AUTHOR_MODEL 优先', () => {
    const env = { RSI_AUTHOR_MODEL: 'env-model' } as NodeJS.ProcessEnv;
    expect(resolveAuthorModel('RSI_AUTHOR_MODEL=file-model\nTRIAL_MODEL=550b', env)).toBe('env-model');
  });

  it('.env 的 RSI_AUTHOR_MODEL 次之', () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(resolveAuthorModel('RSI_AUTHOR_MODEL=file-model\nTRIAL_MODEL=550b', env)).toBe('file-model');
  });

  it('.env 无 RSI_AUTHOR_MODEL 时回退 TRIAL_MODEL（不吃 gpt-4o 默认值）', () => {
    const env = {} as NodeJS.ProcessEnv;
    // 关键回归：2026-11-12 实打实地静默失败过 —— 回退到 NVIDIA 不存在的 gpt-4o → 404。
    expect(resolveAuthorModel('TRIAL_MODEL=nvidia/nemotron-3-ultra-550b-a55b', env)).toBe(
      'nvidia/nemotron-3-ultra-550b-a55b',
    );
    expect(resolveAuthorModel('TRIAL_MODEL=nvidia/nemotron-3-ultra-550b-a55b', env)).not.toBe('gpt-4o');
  });

  // 断言对象是「这台机器上真实那份 .env」，而 server/.env 被 .gitignore 排除：
  // 干净检出上没有这个文件，就没有可断言的现场。记 skip（进 skipped 计数），不算通过。
  it.skipIf(!HAS_SERVER_ENV)('真实 .env 下解析出的模型不是 gpt-4o', () => {
    const envTxt = readFileSync(SERVER_ENV_PATH, 'utf8');
    const model = resolveAuthorModel(envTxt, {} as NodeJS.ProcessEnv);
    expect(model).not.toBe('gpt-4o');
    // 当前 .env 既无 RSI_AUTHOR_MODEL 也无 TRIAL_MODEL 时才可能是 gpt-4o；前者优先。
    expect(model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
  });
});

describe('askAuthor（出题人调用）', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  const fakeProposal: Proposal = {
    id: 'test-case',
    gap: '示例缺口',
    title: '示例标题',
    evidence: ['证据一'],
    targetFile: 'src/tools/builtin/fs-write.tool.ts',
    observable: '可观察行为',
    boundary: '不越界',
  };

  it('把解析出的模型（550b）真正发往 NVIDIA，而不是 gpt-4o', async () => {
    // 注入而不是继承：原先这条只在开发机上成立，因为它靠那份 gitignore 掉的
    // server/.env 供 TRIAL_BASE_URL。干净检出上 base 退化成 '' → URL 只剩
    // '/chat/completions'，红的其实是「测试借了本机现场」，不是产品坏了。
    // 显式给配置后，两个平台量的是同一件事：解析结果真的进了请求 URL 与 body。
    const keys = ['RSI_BASE_URL', 'RSI_API_KEY', 'RSI_AUTHOR_MODEL'] as const;
    const saved: Record<string, string | undefined> = {};
    for (const k of keys) saved[k] = process.env[k];
    process.env.RSI_BASE_URL = 'https://integrate.api.nvidia.com/v1';
    process.env.RSI_API_KEY = 'test-key-not-a-real-credential';
    process.env.RSI_AUTHOR_MODEL = 'nvidia/nemotron-3-ultra-550b-a55b';
    try {
      const fetchMock = vi.fn(async () => ({
        status: 200,
        text: async () => JSON.stringify({ choices: [{ message: { content: '```typescript\n// judge\n```' } }] }),
      }));
      vi.stubGlobal('fetch', fetchMock);

      const out = await askAuthor(fakeProposal);
      expect(out).toContain('judge');

      const [url, init] = fetchMock.mock.calls[0] as [string, { body?: string }];
      expect(url).toContain('integrate.api.nvidia.com/v1/chat/completions');
      const sent = JSON.parse(init.body!);
      expect(sent.model).toBe('nvidia/nemotron-3-ultra-550b-a55b');
      expect(sent.model).not.toBe('gpt-4o');
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });

  it('空响应 / 非 SSE 时抛清晰错误而非静默返回空内容', async () => {
    const fetchMock = vi.fn(async () => ({ status: 200, text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(askAuthor(fakeProposal)).rejects.toThrow(/空内容/);
  });
});
