// AgentWorkbench —— 中栏主工作台：占用条 + 消息流 + 输入区（spec §7 主工作台）
// 发送编排：本地校验 → 本地插入 user/assistant 占位 → SSE → done 后 reconcile 服务端权威数据
// AC-10 干预：打断（输入框停止钮）/ 单步重试 / 从某步重跑 / 改参数（审批条内）全部接 agent/stream

import { useCallback, useState } from 'react';
import { TriangleAlert, Gauge, History, LineChart, MessageSquare, ShieldAlert, ShieldCheck, Sparkles, Wrench } from 'lucide-react';
import type { AgentStreamRequest, SessionMessageRow, Task } from '../../types';
import { buildAgentStreamRequest, rerunFromPatch, TASK_MODES } from '../../lib/agent-request';
import { useServerSessionStore } from '../../stores/serverSessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUiStore } from '../../stores/uiStore';
import { useRunStore } from '../../stores/runStore';
import { useApprovalStore } from '../../stores/approvalStore';
import { useAgentStream } from '../../hooks/useAgentStream';
import { abortAgentRun } from '../../services/api';
import { createId } from '../../lib/format';
import { ContextOccupancyBar } from './ContextOccupancyBar';
import { AgentMessageList } from './AgentMessageList';
import { AgentInput } from './AgentInput';
import { RunStageBanner } from './RunStageBanner';
import { RunReportCard } from './RunReportCard';
import { ResumeConflictCard } from './ResumeConflictCard';
import { AuditView } from './AuditView';
import { SandboxGrantBar } from './SandboxGrantBar';
import { SandboxPermissionModal } from '../settings/SandboxPermissionModal';
import { JudgePanelModal } from './JudgePanelModal';
import { RsiDashboardModal } from './RsiDashboardModal';
import { RsiIterationGate } from './RsiIterationGate';
import { Modal } from '../common/Modal';
import { cn } from '../../lib/cn';

/**
 * URL 直达（交接 / 演示用）：?rsi=1&session=<id>
 * 打开页面即展开 RSI 读数面板，并优先用 URL 指定的会话取数，
 * 避免先手动选会话、再点按钮才能看到判据读数。
 */
function rsiDeepLink(): { open: boolean; sessionId: string | null } {
  if (typeof window === 'undefined') return { open: false, sessionId: null };
  const params = new URLSearchParams(window.location.search);
  return { open: params.get('rsi') === '1', sessionId: params.get('session') };
}

const SUGGESTIONS = [
  '用计算工具算 (1234.5*87)/13，并说明每一步',
  '读取 data 目录下的文件列表',
  '生成一个 UUID 并格式化为 JSON',
];

// 任务模式选择器选项：自动（缺省，模型自定）+ 四类核心能力
const TASK_MODE_OPTIONS: Array<{ value: Task | null; label: string }> = [
  { value: null, label: '自动' },
  ...TASK_MODES.map((m) => ({ value: m.value, label: m.label })),
];

/** 错误的可行动指引：上游不可用时给出「哪类错误 + 建议动作 + 一键去配 Key」。 */
interface ErrorGuidance {
  hint: string;
  action: string;
}

/**
 * 把错误码/文案归类成用户能照做的下一步。
 * 返回 null 表示这条错误不需要用户改配置（如工具参数校验失败），只展示原文。
 */
function guidanceFor(code: string, message: string): ErrorGuidance | null {
  if (code === 'CONFIG_ERROR') {
    return { hint: '这是本地配置问题，补齐设置后再发送即可。', action: '去设置补全' };
  }
  if (code === 'MISSING_API_KEY' || /认证失败|鉴权|无效.{0,6}key|401|403/i.test(message)) {
    return {
      hint: '当前上游拒绝了这份凭据。到「设置 → Provider」更新 API Key；若是免费试用，配自己的 Key 即可自由切换上游。',
      action: '去配置自己的 Key',
    };
  }
  if (code === 'NOT_FOUND' || /HTTP_40[34]|模型不存在|没有该模型|model.?(not.?found|unknown|does.?not.?exist)/i.test(message)) {
    return {
      hint: '上游不认识当前模型。试用期的上游与模型由服务端固定；需要换模型请自带 Key。',
      action: '去配置自己的 Key',
    };
  }
  if (code === 'UPSTREAM_TIMEOUT' || /超时|timeout/i.test(message)) {
    return {
      hint: '上游在限定时间内没有响应（不是本地故障）。可直接重试，或到设置换上游 / 调大超时（UPSTREAM_TIMEOUT_MS）。',
      action: '去配置自己的 Key',
    };
  }
  if (code === 'NETWORK_ERROR' || /无法连接|网络不可达|fetch failed|ECONN/i.test(message)) {
    return {
      hint: '本机到上游的网络不可达。先确认网络/代理，再把 Base URL 换成你能访问的端点。',
      action: '去配置自己的 Key',
    };
  }
  if (code === 'BUDGET_EXCEEDED' || /试用额度|额度已用完/i.test(message)) {
    return {
      hint: '今日免费试用次数已用完；配置自己的 API Key 后可继续使用（不受每日次数限制）。',
      action: '去配置自己的 Key',
    };
  }
  return null;
}

export function AgentWorkbench() {
  const session = useServerSessionStore((s) => s.sessions.find((x) => x.id === s.activeSessionId) ?? null);
  const messages = useServerSessionStore((s) => s.messages);
  const createOnServer = useServerSessionStore((s) => s.createOnServer);
  const renameOnServer = useServerSessionStore((s) => s.renameOnServer);
  const appendLocalMessage = useServerSessionStore((s) => s.appendLocalMessage);
  const removeLocalMessagesFrom = useServerSessionStore((s) => s.removeLocalMessagesFrom);
  const settings = useSettingsStore((s) => s.settings);
  const streaming = useRunStore((s) => s.streaming);
  const { error, start, abort } = useAgentStream();
  const resetApprovals = useApprovalStore((s) => s.reset);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [taskKind, setTaskKind] = useState<Task | null>(null);
  const [permOpen, setPermOpen] = useState(false);
  const [judgeOpen, setJudgeOpen] = useState(false);
  const [rsiOpen, setRsiOpen] = useState(() => rsiDeepLink().open);
  const [iterationOpen, setIterationOpen] = useState(false);
  const setSettingsOpen = useUiStore((s) => s.setSettingsOpen);
  const showRecoveryCode = useUiStore((s) => s.showRecoveryCode);
  // F：主视图切换（会话 / 审计台）。审计台按当前 runId 取数，不另存一份运行态。
  const [view, setView] = useState<'chat' | 'audit'>('chat');
  const runId = useRunStore((s) => s.runId);
  // 错误条按「码 + 文案」归类：认证/模型不存在/超时/网络/额度 → 都给可行动入口
  const errorBar = sessionError ? { code: 'CONFIG_ERROR', message: sessionError } : error;
  const errorGuidance = errorBar ? guidanceFor(errorBar.code, errorBar.message) : null;

  const buildRequest = useCallback(
    (message: string, sessionId: string, patch?: Partial<AgentStreamRequest>): AgentStreamRequest =>
      buildAgentStreamRequest(settings, message, sessionId, patch),
    [settings],
  );

  /** 确保有会话：无则先创建（恢复码由 AppShell 统一弹示） */
  const ensureSession = useCallback(async (): Promise<string | null> => {
    if (session) return session.id;
    try {
      const created = await createOnServer({ provider: settings.provider, model: settings.model });
      // 与侧栏「新建会话」一致：恢复码只在创建时明文一次，必须立刻弹窗，不能丢。
      showRecoveryCode(created.recoveryCode);
      return created.session.id;
    } catch (err) {
      setSessionError(err instanceof Error ? err.message : '会话创建失败');
      return null;
    }
  }, [session, createOnServer, settings.provider, settings.model, showRecoveryCode]);

  const runTask = useCallback(
    async (text: string, patch?: Partial<AgentStreamRequest>, dropFromMessageId?: string): Promise<void> => {
      if (streaming) return;
      setSessionError(null);
      // 防御：model 为空（理论上已被 settingsStore 保证非空，此处兜底避免裸服务端校验报错）
      if (!useSettingsStore.getState().settings.model.trim()) {
        setSessionError('请先选择模型（或在自定义 Provider 下填写模型名称）');
        return;
      }
      // 防御：自定义 Provider 缺 Base URL 时本地即拦截，避免服务端抛内部错误
      const current = useSettingsStore.getState().settings;
      if (current.provider === 'custom' && !current.customBaseUrl?.trim()) {
        setSessionError('自定义 Provider 需要先填写 Base URL（设置 → Provider → Base URL）');
        return;
      }
      const sessionId = await ensureSession();
      if (!sessionId) return;

      // AC-10 resume：本地同步回退（服务端也会 markSkippedFrom + deleteAfter）
      if (dropFromMessageId) removeLocalMessagesFrom(dropFromMessageId);

      const now = Date.now();
      const userMessage: SessionMessageRow = {
        id: createId('msg'),
        seq: messages.length + 1,
        role: 'user',
        content: text,
        segments: [{ type: 'text', text }],
        tokens: 0,
        isSummary: false,
        createdAt: now,
        status: 'done',
      };
      const assistantMessage: SessionMessageRow = {
        id: createId('msg'),
        seq: messages.length + 2,
        role: 'assistant',
        content: '',
        segments: [],
        tokens: 0,
        isSummary: false,
        createdAt: now + 1,
        status: 'streaming',
      };
      appendLocalMessage(userMessage);
      appendLocalMessage(assistantMessage);

      const isFirst = messages.length === 0;
      if (isFirst) {
        const title = text.split('\n')[0].trim().slice(0, 20) || '新会话';
        void renameOnServer(sessionId, title);
      }

      // 干预运行复用同一循环：resumeFromCallId / overrideArguments 只是请求体字段
      await start(buildRequest(text, sessionId, patch), { messageId: assistantMessage.id });
    },
    [
      streaming,
      ensureSession,
      messages.length,
      appendLocalMessage,
      removeLocalMessagesFrom,
      renameOnServer,
      buildRequest,
      start,
    ],
  );

  const handleSend = useCallback(
    (text: string) => {
      void runTask(text, taskKind ? { taskKind } : undefined);
    },
    [runTask, taskKind],
  );

  /** AC-10 单步重试：从该 callId 重跑（服务端将其后步骤置 skipped） */
  const handleRetryStep = useCallback(
    (callId: string) => {
      void runTask(`重试工具调用 ${callId}`, { resumeFromCallId: callId });
    },
    [runTask],
  );

  /** AC-10 从某步重跑：同参数重跑该步及其后继（携带该步原参数为 overrideArguments） */
  const handleRerunFrom = useCallback(
    (callId: string, overrideArguments?: Record<string, unknown>) => {
      void runTask(`从调用 ${callId} 起重跑`, rerunFromPatch(callId, overrideArguments));
    },
    [runTask],
  );

  const handleStop = useCallback(() => {
    abort();
    resetApprovals();
    // P1-6：服务端直停。本地 abort() 依赖「断开→res.close」间接停 run；
    // 显式 POST /agent/abort 不等 TCP 关闭传播，跨标签页时也是唯一入口。
    // best-effort：失败不影响本地已完成的收尾。
    const sessionId = useServerSessionStore.getState().activeSessionId;
    if (sessionId) void abortAgentRun(sessionId).catch(() => undefined);
  }, [abort, resetApprovals]);

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-bg-primary">
      {/* 会话头：标题 + 通道徽标 */}
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border px-3">
        <Sparkles size={15} className="text-accent" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">
          {session?.title ?? '新会话'}
        </span>
        <div role="group" aria-label="主视图切换" className="flex shrink-0 items-center rounded-md border border-border p-0.5">
          <button
            type="button"
            aria-pressed={view === 'chat'}
            onClick={() => setView('chat')}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              view === 'chat' ? 'bg-accent-subtle text-accent' : 'text-text-secondary hover:text-accent',
            )}
          >
            <MessageSquare size={12} /> 会话
          </button>
          <button
            type="button"
            aria-pressed={view === 'audit'}
            onClick={() => setView('audit')}
            className={cn(
              'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              view === 'audit' ? 'bg-accent-subtle text-accent' : 'text-text-secondary hover:text-accent',
            )}
          >
            <History size={12} /> 审计台
          </button>
        </div>
        <button
          type="button"
          onClick={() => setJudgeOpen(true)}
          title="判据塔：判决历史、自证状态与经验有效性"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <Gauge size={13} />
          判据塔
        </button>
        <button
          type="button"
          onClick={() => setRsiOpen(true)}
          title="RSI 判据读数：套件通过率、分母基线与代际曲线"
          aria-label="RSI 判据读数"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <LineChart size={13} />
          <span className="hidden sm:inline">RSI 曲线</span>
        </button>
        <button
          type="button"
          onClick={() => setIterationOpen(true)}
          title="自我迭代闸门：逐轮的量化判据、去留决策与人工处置"
          aria-label="自我迭代闸门"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <ShieldCheck size={13} />
          <span className="hidden sm:inline">迭代闸门</span>
        </button>
        <button
          type="button"
          onClick={() => setPermOpen(true)}
          title="沙箱权限：放开沙箱外目录与免审批"
          className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <ShieldAlert size={13} />
          沙箱权限
        </button>
        {error && !streaming && (
          <span className="shrink-0 text-xs text-danger" title={error.message}>
            {error.code}
          </span>
        )}
      </header>

      {view === 'audit' ? (
        <AuditView runId={runId} />
      ) : (
        <>
      <ContextOccupancyBar />

      <AgentMessageList
        messages={messages}
        onRetryStep={handleRetryStep}
        onRerunFrom={handleRerunFrom}
        busy={streaming}
        empty={<WorkbenchEmpty onPick={handleSend} hasKey={!!settings.apiKey.trim()} />}
      />

      {/* 错误条：完整展示多行引导 + 错误码 + 建议动作（上游不可用时不白屏、不裸报错） */}
      {errorBar && (
        <div role="alert" className="shrink-0 border-t border-danger bg-danger-subtle px-3 py-2">
          <div className="flex items-start gap-2">
            <TriangleAlert size={13} className="mt-0.5 shrink-0 text-danger" />
            <div className="min-w-0 flex-1">
              <p className="whitespace-pre-line text-xs leading-relaxed text-danger">{errorBar.message}</p>
              {errorBar.code !== 'CONFIG_ERROR' && (
                <p className="mt-0.5 text-[11px] text-text-secondary">错误代码：{errorBar.code}</p>
              )}
              {errorGuidance && (
                <p className="mt-1 whitespace-pre-line text-[11px] leading-relaxed text-text-secondary">
                  建议：{errorGuidance.hint}
                </p>
              )}
            </div>
            {errorGuidance && (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="shrink-0 rounded border border-danger px-2 py-0.5 text-xs text-danger transition-colors duration-150 hover:bg-danger hover:text-bg-primary"
              >
                {errorGuidance.action}
              </button>
            )}
          </div>
        </div>
      )}

      {/* R3：阶段与等待计时（连接上游 / 已响应 / 生成中），超时升级提示 + 中止入口 */}
      <RunStageBanner onAbort={handleStop} />
      <SandboxGrantBar />
      {/* C/F：续跑冲突态（只展示与阻止，不自动覆盖） */}
      <ResumeConflictCard />
      <RunReportCard />

      {/* 任务模式选择器：四类核心能力（AUDIT-006 接线） */}
      <div className="flex shrink-0 items-center gap-1 border-t border-border px-3 py-2">
        <span className="mr-1 text-xs text-text-tertiary">任务模式</span>
        <div className="flex flex-wrap gap-1">
          {TASK_MODE_OPTIONS.map((opt) => (
            <button
              key={opt.label}
              type="button"
              disabled={streaming}
              aria-pressed={taskKind === opt.value}
              onClick={() => setTaskKind(opt.value)}
              className={cn(
                'rounded-md border px-2 py-1 text-xs transition-colors duration-150',
                taskKind === opt.value
                  ? 'border-accent bg-accent-subtle text-accent'
                  : 'border-border text-text-secondary hover:border-accent hover:text-accent',
                streaming && 'cursor-not-allowed opacity-50',
              )}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      <AgentInput onSend={handleSend} onStop={handleStop} streaming={streaming} />
        </>
      )}

      <SandboxPermissionModal open={permOpen} onClose={() => setPermOpen(false)} />
      <JudgePanelModal open={judgeOpen} onClose={() => setJudgeOpen(false)} />
      <RsiDashboardModal open={rsiOpen} onClose={() => setRsiOpen(false)} sessionId={rsiDeepLink().sessionId ?? session?.id ?? null} />
      <Modal open={iterationOpen} onClose={() => setIterationOpen(false)} title="自我迭代闸门" maxWidth={880}>
        <RsiIterationGate />
      </Modal>
    </div>
  );
}

function WorkbenchEmpty({ onPick, hasKey }: { onPick: (text: string) => void; hasKey: boolean }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 py-10">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-accent-subtle">
        <Wrench size={22} className="text-accent" />
      </div>
      <div className="text-center">
        <p className="text-sm font-medium text-text-primary">一句话交代，Agent 动手；每步可见，风险处你拍板</p>
        <p className="mt-1 text-xs text-text-secondary">
          工具调用、参数与结果都摊在界面上；写文件、执行命令等高风险动作按等级先请示你，密钥只留在本机（BYOK）。
          {!hasKey && '未配置 Key 时可先用免费试用（上游与模型由服务端固定）；自带 Key 后即可自由切换上游与模型。'}
        </p>
      </div>
      <div className="flex w-full max-w-md flex-col gap-1.5">
        {SUGGESTIONS.map((text) => (
          <button
            key={text}
            type="button"
            onClick={() => onPick(text)}
            className={cn(
              'rounded-md border border-border px-3 py-2 text-left text-xs text-text-secondary',
              'transition-colors duration-150 hover:border-accent hover:text-accent',
            )}
          >
            {text}
          </button>
        ))}
      </div>
    </div>
  );
}
