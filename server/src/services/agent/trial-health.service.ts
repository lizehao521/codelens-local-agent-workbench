/**
 * 试用上游可用性自检（启动时异步跑一次，不阻断启动）。
 *
 * R4：旧实现用 `GET /models` 判断可用性，但 NVIDIA 等上游的 /models 不校验鉴权——
 * Key 错了也返回 200，等于没测（假绿）。现在改为**真实最小生成探测**：
 * `POST /chat/completions`，`max_tokens=1`、非流式、12s 超时，只验证能否建立一次
 * 真实生成请求。单次成本约 1 个 completion token + 极短 prompt，可忽略。
 *
 * 结果三态：ok / auth_failed（401/403）/ unreachable（网络、超时、其它非 2xx）。
 * 启动时异步执行一次并缓存 5 分钟（`checkOnce` 默认命中缓存），失败只 warn、不阻塞启动。
 */

export type TrialProbeStatus = 'unknown' | 'ok' | 'auth_failed' | 'unreachable';

export interface TrialProbeTokens {
  promptTokens: number;
  completionTokens: number;
}

export interface TrialUpstreamHealth {
  status: TrialProbeStatus;
  /** 诊断说明（不含密钥）；ok / unknown 时为 null。 */
  detail: string | null;
  checkedAt: number | null;
  /** 最近一次真实探测的耗时（ms）；从未探测为 null。 */
  durationMs: number | null;
  /** 最近一次探测实际上游返回的 token 用量；上游未返回 usage 时为 null。 */
  tokens: TrialProbeTokens | null;
  /** 本次读取是否命中了缓存（true = 没有发新请求）。 */
  cached: boolean;
}

export interface TrialHealthOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** 探测超时，默认 12s（10–15s 区间内，兼顾慢上游与启动期等待）。 */
  timeoutMs?: number;
  /** 结果缓存窗口，默认 5 分钟。 */
  cacheMs?: number;
  fetchFn?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_CACHE_MS = 5 * 60_000;
const PROBE_MAX_TOKENS = 1;
/**
 * 失败结果的自动复探窗口。
 *
 * 缓存 5 分钟对「ok」是对的（省请求），但对失败是灾难：上游从故障恢复后，
 * `/trial-status` 会继续红最长 5 分钟，用户看到「上游不可用」而实际对话已经能用。
 * 因此失败态超过该窗口后，下一次读取会顺带在后台复探一次（单飞，不叠加）。
 */
const STALE_FAILURE_REFRESH_MS = 20_000;

function upstreamHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export class TrialHealthService {
  private state: TrialUpstreamHealth = {
    status: 'unknown',
    detail: null,
    checkedAt: null,
    durationMs: null,
    tokens: null,
    cached: false,
  };

  /** 后台复探是否在飞（单飞闸：多个轮询不会同时打上游）。 */
  private refreshing = false;

  constructor(private readonly cfg: TrialHealthOptions | null) {}

  /** 当前自检结果（无副作用，供 API 读取）。 */
  get(): TrialUpstreamHealth {
    return this.state;
  }

  /**
   * 失败结果超窗后触发一次后台复探（`/trial-status` 读取时顺带调用）。
   * 返回 null 表示没触发（未配置 / ok 态 / 未到窗口 / 已有复探在飞）。
   */
  refreshIfStaleFailure(): Promise<TrialUpstreamHealth> | null {
    if (!this.cfg || !this.cfg.apiKey || !this.cfg.model) return null;
    if (this.refreshing) return null;
    if (this.state.status !== 'unreachable' && this.state.status !== 'auth_failed') return null;
    if (this.state.checkedAt !== null && Date.now() - this.state.checkedAt < STALE_FAILURE_REFRESH_MS) return null;

    this.refreshing = true;
    return this.checkOnce(true).finally(() => {
      this.refreshing = false;
    });
  }

  /**
   * 探测一次。默认在缓存窗口内直接返回上次结果（cached=true）；
   * `force` 用于需要立刻复测的场景（手动自检）。
   */
  async checkOnce(force = false): Promise<TrialUpstreamHealth> {
    if (!this.cfg || !this.cfg.apiKey || !this.cfg.model) return this.state;

    const cacheMs = this.cfg.cacheMs ?? DEFAULT_CACHE_MS;
    if (
      !force &&
      this.state.status !== 'unknown' &&
      this.state.checkedAt !== null &&
      Date.now() - this.state.checkedAt < cacheMs
    ) {
      this.state = { ...this.state, cached: true };
      return this.state;
    }

    const base = this.cfg.baseUrl.replace(/\/+$/, '');
    const host = upstreamHost(base);
    const fetchFn = this.cfg.fetchFn ?? globalThis.fetch;
    const startedAt = Date.now();

    try {
      const res = await fetchFn(`${base}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages: [{ role: 'user', content: 'ping' }],
          max_tokens: PROBE_MAX_TOKENS,
          temperature: 0,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS),
      });
      const durationMs = Date.now() - startedAt;

      if (res.status === 401 || res.status === 403) {
        this.state = {
          status: 'auth_failed',
          detail: `上游（${host}）认证失败（HTTP ${res.status}）：API Key 无效、已过期或无此模型权限`,
          checkedAt: Date.now(),
          durationMs,
          tokens: null,
          cached: false,
        };
      } else if (!res.ok) {
        this.state = {
          status: 'unreachable',
          detail: `上游（${host}）返回 HTTP ${res.status}，无法完成生成探测`,
          checkedAt: Date.now(),
          durationMs,
          tokens: null,
          cached: false,
        };
      } else {
        const usage = await this.readUsage(res);
        this.state = {
          status: 'ok',
          detail: null,
          checkedAt: Date.now(),
          durationMs,
          tokens: usage,
          cached: false,
        };
      }
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      const name = err instanceof Error ? err.name : 'Error';
      const timedOut = name === 'TimeoutError' || name === 'AbortError';
      this.state = {
        status: 'unreachable',
        detail: timedOut
          ? `上游（${host}）在探测超时内无响应`
          : `上游（${host}）不可达（网络错误）`,
        checkedAt: Date.now(),
        durationMs,
        tokens: null,
        cached: false,
      };
    }

    if (this.state.status !== 'ok') {
      // 不静默：启动日志里明确写出上游地址与失败类别（地址不是密钥）。
      console.warn(`[codelens] 试用上游真实生成探测未通过（${this.state.status}）：${this.state.detail}`);
    }
    return this.state;
  }

  /** 只读 usage，不抛异常：探测本身不依赖用量字段。 */
  private async readUsage(res: Response): Promise<TrialProbeTokens | null> {
    try {
      const payload = (await res.json()) as { usage?: { prompt_tokens?: number; completion_tokens?: number } };
      const usage = payload?.usage;
      if (!usage) return null;
      return {
        promptTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
        completionTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      };
    } catch {
      return null;
    }
  }
}
