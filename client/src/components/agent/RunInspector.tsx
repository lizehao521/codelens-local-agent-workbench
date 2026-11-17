// RunInspector —— 右栏运行检视器：当前运行的通道/轮次/工具数 + 任务成本 + 七态统计
// 与中栏解耦：只订阅 runStore 与 toolCallStore，不随消息流重渲染。

import { useMemo } from 'react';
import { TriangleAlert, Gauge, ListOrdered, Sparkles, Wrench } from 'lucide-react';
import { useRunStore } from '../../stores/runStore';
import { countUnsuccessful, useToolCallStore } from '../../stores/toolCallStore';
import { fmtTokens, formatDuration } from '../../lib/tool-format';
import { cn } from '../../lib/cn';

export function RunInspector() {
  const meta = useRunStore((s) => s.meta);
  const streaming = useRunStore((s) => s.streaming);
  const run = useRunStore((s) => s.run);
  const error = useRunStore((s) => s.error);
  const stages = useRunStore((s) => s.stageHistory);
  const report = useRunStore((s) => s.report);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!meta && !run && !error && stages.length === 0 && (
          <p className="text-xs text-text-tertiary">任务开始后，这里显示阶段、成本与风险。</p>
        )}

        {/* F：阶段序列 —— 一眼看出「它现在在干什么」 */}
        <section className="mb-4" aria-live="polite" aria-label="阶段序列">
          <GroupTitle icon={ListOrdered} title="阶段序列" />
          {stages.length === 0 ? (
            <p className="text-xs text-text-tertiary">尚未开始（等待首个阶段事件）。</p>
          ) : (
            <ol className="space-y-1">
              {stages.slice(-8).map((item, index) => (
                <li key={`${item.stage}-${index}`} className="flex items-baseline gap-2 text-xs">
                  <span className="w-4 shrink-0 text-text-tertiary">{stages.length - Math.min(8, stages.length) + index + 1}</span>
                  <span className="shrink-0 text-text-primary">{stageLabel(item.stage)}</span>
                  <span className="min-w-0 truncate text-text-tertiary">{item.detail ?? ''}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {/* F：风险项 —— 汇报卡的触发项与失败工具集中呈现 */}
        <section className="mb-4" aria-live="polite" aria-label="风险项">
          <GroupTitle icon={TriangleAlert} title="风险项" />
          {(report?.triggers.length ?? 0) === 0 && !error ? (
            <p className="text-xs text-text-tertiary">暂无风险项。</p>
          ) : (
            <ul className="space-y-0.5 text-xs">
              {report?.triggers.map((trigger) => (
                <li key={trigger} className="text-warning">
                  · {trigger}
                </li>
              ))}
              {error && <li className="text-danger">· {error.code}：{error.message}</li>}
            </ul>
          )}
        </section>

        {meta && (
          <section className="mb-4">
            <GroupTitle icon={Gauge} title="本次运行" />
            <Row label="供应商 / 模型" value={`${meta.provider} / ${meta.model}`} mono />
            <Row
              label="通道"
              value={
                <span className="flex items-center gap-1">
                  {meta.channel === 'native' ? '原生 function calling' : '提示词解析模式（ReAct）'}
                  {meta.degraded && (
                    <span className="rounded bg-warning-subtle px-1 text-xs text-warning">已降级</span>
                  )}
                </span>
              }
            />
            {meta.degradedReason && <Row label="降级原因" value={meta.degradedReason} />}
            <Row label="轮次" value={`${meta.iteration} / ${meta.maxIterations}`} mono />
            {typeof meta.toolCount === 'number' && <Row label="可用工具" value={String(meta.toolCount)} mono />}
            {typeof meta.contextWindow === 'number' && (
              <Row label="上下文窗口" value={fmtTokens(meta.contextWindow)} mono />
            )}
          </section>
        )}

        {run && (
          <section className="mb-4">
            <GroupTitle icon={Sparkles} title="任务成本" />
            <Row label="结束原因" value={finishReasonLabel(run.finishReason)} />
            <Row label="工具调用" value={String(run.toolCallCount)} mono />
            <Row label="本次轮次" value={String(run.iteration)} mono />
            <Row label="耗时" value={formatDuration(run.elapsedMs)} mono />
            {typeof run.firstTokenMs === 'number' && (
              <Row label="首 token" value={formatDuration(run.firstTokenMs)} mono />
            )}
            {run.usage && (
              <Row
                label="Token"
                value={`${fmtTokens(run.usage.promptTokens)} 入 / ${fmtTokens(run.usage.completionTokens)} 出`}
                mono
              />
            )}
          </section>
        )}

        {error && (
          <section className="mb-4">
            <GroupTitle icon={Wrench} title="错误" />
            <p className="text-xs text-danger">{error.message}</p>
            <p className="mt-0.5 font-mono text-xs text-text-tertiary">{error.code}</p>
          </section>
        )}

        <CurrentRunStats streaming={streaming} />
      </div>
    </div>
  );
}

/** 当前消息序列的工具统计（订阅整个 byId 变化即可，卡片量级小） */
function CurrentRunStats({ streaming }: { streaming: boolean }) {
  const byId = useToolCallStore((s) => s.byId);
  const calls = useMemo(() => Object.values(byId), [byId]);
  if (calls.length === 0) return null;
  const failures = countUnsuccessful(calls);
  const running = calls.filter((c) => c.status === 'running' || c.status === 'pending').length;

  return (
    <section>
      <GroupTitle icon={Wrench} title="工具调用" />
      <Row label="总数" value={String(calls.length)} mono />
      <Row label="进行中" value={running > 0 ? String(running) : '—'} mono />
      <Row label="未成功" value={failures > 0 ? String(failures) : '—'} mono className={failures > 0 ? 'text-danger' : undefined} />
      {streaming && <p className="mt-1 text-xs text-accent">任务进行中…</p>}
    </section>
  );
}

function GroupTitle({ icon: Icon, title }: { icon: typeof Gauge; title: string }) {
  return (
    <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-text-secondary">
      <Icon size={12} />
      {title}
    </h3>
  );
}

function Row({
  label,
  value,
  mono,
  className,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
  className?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 py-0.5">
      <span className="shrink-0 text-xs text-text-tertiary">{label}</span>
      <span className={cn('min-w-0 truncate text-right text-xs text-text-primary', mono && 'font-mono', className)}>
        {value}
      </span>
    </div>
  );
}

function finishReasonLabel(reason: string): string {
  switch (reason) {
    case 'stop':
      return '正常完成';
    case 'max_iterations':
      return '达到轮次上限';
    case 'budget_exhausted':
      return '预算耗尽';
    case 'converged':
      return '收敛停止';
    case 'aborted':
      return '已中止';
    case 'circuit_open':
      return '工具熔断中止';
    default:
      return reason;
  }
}

function stageLabel(stage: string): string {
  switch (stage) {
    case 'connecting':
      return '连接上游';
    case 'upstream_first_byte':
      return '已收到响应';
    case 'reasoning':
    case 'thinking':
      return '思考';
    case 'content':
    case 'responding':
      return '生成回复';
    case 'done':
      return '收尾';
    case 'upstream_error':
      return '上游错误';
    case 'upstream_timeout':
      return '上游超时';
    case 'budget_adapted':
      return '自适应预算';
    case 'aborted':
      return '已中止';
    case 'tool_call':
      return '调用工具';
    case 'observing':
      return '观察结果';
    case 'reviewing':
      return '复核';
    default:
      return stage;
  }
}
