// AuditView —— D：审计台（薄文件视图，不做编辑器）。
// 文件树 + 单文件 diff；diff 全部来自服务端快照的 before/after（diff_json），
// 不用当前磁盘重算。每条 hunk 标注来源步骤 / 调用，点击可反查审批与快照版本，
// 撤销复用既有 checkpoint rollback（run 级 + 文件级）。

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Folder,
  History,
  PlayCircle,
  RefreshCw,
  Undo2,
} from 'lucide-react';
import type { RunAuditFileDiff, RunAuditResponse } from '../../types';
import { getRunAudit, resumeRun, rollbackRun } from '../../services/api';
import { useRunStore } from '../../stores/runStore';
import { cn } from '../../lib/cn';
import { computeDiffWindow } from './audit-window';

const ROW_HEIGHT = 18;
const VIEWPORT_HEIGHT = 360;

interface Props {
  runId: string | null;
}

interface RenderLine {
  text: string;
  kind: 'add' | 'del' | 'context' | 'meta';
  step: number | null;
  checkpointId: string;
  toolCallIds: string[];
}

function linesForFile(data: RunAuditResponse, path: string): RenderLine[] {
  const out: RenderLine[] = [];
  for (const step of data.steps) {
    const file = step.files.find((f) => f.path === path);
    if (!file || !file.diff) continue;
    out.push({
      text: `@@ 第 ${step.step ?? '?'} 步 · ${step.toolCallIds.join(', ') || '无调用'} · 快照 ${step.checkpointId}${
        file.operation === 'create' ? ' · 新增' : ''
      }`,
      kind: 'meta',
      step: step.step,
      checkpointId: step.checkpointId,
      toolCallIds: step.toolCallIds,
    });
    for (const line of file.diff.split('\n')) {
      out.push({
        text: line,
        kind: line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'context',
        step: step.step,
        checkpointId: step.checkpointId,
        toolCallIds: step.toolCallIds,
      });
    }
  }
  return out;
}

export function AuditView({ runId }: Props) {
  const [data, setData] = useState<RunAuditResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [openStep, setOpenStep] = useState<number | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [renderMs, setRenderMs] = useState<number | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resumeNotice, setResumeNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 撤销确认：确认前不改任何东西；`trigger` 记下发起元素，完成后把焦点还回去。 */
  const [pendingUndo, setPendingUndo] = useState<{ kind: 'run' } | { kind: 'file'; path: string } | null>(null);
  const undoTriggerRef = useRef<HTMLElement | null>(null);
  const runUndoRef = useRef<HTMLButtonElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  /** 每次撤销结束 +1；配合 busy 提交后再归还焦点。 */
  const [focusEpoch, setFocusEpoch] = useState(0);
  const setResumeConflict = useRunStore((s) => s.setResumeConflict);

  const load = useCallback(async () => {
    if (!runId) return;
    setLoading(true);
    setError(null);
    try {
      const next = await getRunAudit(runId);
      setData(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '审计数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    setData(null);
    setSelected(null);
    setOpenStep(null);
    if (runId) void load();
  }, [runId, load]);

  // 键盘主线要求「Esc 退出步骤详情」：焦点在 diff 行（详情面板之外），
  // 因此不能只给面板挂 onKeyDown，需在文档级监听；仅详情打开时生效。
  useEffect(() => {
    if (openStep == null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpenStep(null);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [openStep]);

  const selectedPath = selected ?? data?.files[0]?.path ?? null;
  const lines = useMemo(
    () => (data && selectedPath ? linesForFile(data, selectedPath) : []),
    [data, selectedPath],
  );

  useEffect(() => {
    if (lines.length === 0) return;
    const t0 = performance.now();
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(() => setRenderMs(Math.round(performance.now() - t0)))
        : setTimeout(() => setRenderMs(Math.round(performance.now() - t0)), 0);
    return () => {
      if (typeof raf === 'number' && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    };
  }, [lines]);

  const windowRange = computeDiffWindow(lines.length, scrollTop, VIEWPORT_HEIGHT, ROW_HEIGHT);
  const visible = lines.slice(windowRange.start, windowRange.end);
  const selectedFile: RunAuditFileDiff | null = data && selectedPath
    ? data.steps.flatMap((s) => s.files).filter((f) => f.path === selectedPath).slice(-1)[0] ?? null
    : null;

  const restoreFocus = useCallback(() => {
    // 撤销按钮在 busy 期间 disabled，焦点会被浏览器丢到 BODY；
    // 等本轮状态刷新完成后再把焦点还给发起元素，键盘用户的 Tab 顺序才连续。
    const trigger = undoTriggerRef.current;
    if (trigger && trigger.isConnected && !(trigger as HTMLButtonElement | null)?.disabled) {
      trigger.focus();
      return;
    }
    if (runUndoRef.current?.isConnected && !runUndoRef.current.disabled) {
      runUndoRef.current.focus();
    }
  }, []);

  // busy=false 提交到 DOM 之后再还焦点（disabled 元素无法被 focus()）。
  useEffect(() => {
    if (focusEpoch === 0 || busy) return;
    restoreFocus();
  }, [focusEpoch, busy, restoreFocus]);

  const undo = async (opts: { step?: number; files?: string[] }) => {
    if (!runId || busy) return;
    setBusy(true);
    setActionError(null);
    try {
      await rollbackRun(runId, opts);
      await load();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : '撤销失败');
    } finally {
      setBusy(false);
      setFocusEpoch((epoch) => epoch + 1);
    }
  };

  /** 撤销入口：先记下触发元素并弹确认，确认后才真正执行。 */
  const requestUndo = (
    target: { kind: 'run' } | { kind: 'file'; path: string },
    trigger?: HTMLElement | null,
  ) => {
    if (busy) return;
    // 以事件源为准：程序化 click（测试/辅助工具）不会把焦点放到按钮上，
    // 只依赖 activeElement 会把「回到触发元素」退化成 BODY。
    undoTriggerRef.current =
      trigger ??
      (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setPendingUndo(target);
  };

  const cancelUndo = () => {
    setPendingUndo(null);
    restoreFocus();
  };

  const confirmUndo = async () => {
    const target = pendingUndo;
    if (!target) return;
    setPendingUndo(null);
    await undo(target.kind === 'run' ? {} : { files: [target.path] });
  };

  // 确认框打开时把焦点放在安全选项（取消），Esc 等价于取消；Tab 在框内循环。
  useEffect(() => {
    if (!pendingUndo) return;
    cancelRef.current?.focus();
  }, [pendingUndo]);

  const undoImpact = useMemo(() => {
    if (!data || !pendingUndo) return { restore: 0, remove: 0 };
    const targetPath = pendingUndo.kind === 'file' ? pendingUndo.path : null;
    const byPath = new Map<string, 'write' | 'create'>();
    for (const step of data.steps) {
      // 已撤销过的快照不再计入「将恢复 / 将删除」，避免重复承诺。
      if (step.status !== 'active' || step.restoredAt != null) continue;
      for (const file of step.files) {
        if (targetPath && file.path !== targetPath) continue;
        byPath.set(file.path, file.operation ?? 'write');
      }
    }
    let restore = 0;
    let remove = 0;
    for (const operation of byPath.values()) {
      if (operation === 'create') remove += 1;
      else restore += 1;
    }
    return { restore, remove };
  }, [data, pendingUndo]);

  const onDialogKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelUndo();
      return;
    }
    if (event.key !== 'Tab' || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLButtonElement>('button')].filter(
      (node) => !node.disabled,
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const checkResume = async () => {
    if (!runId) return;
    setResumeNotice(null);
    const result = await resumeRun(runId);
    if (result.status === 'conflict') {
      setResumeConflict({ runId, conflicts: result.conflicts });
      setResumeNotice(`发现 ${result.conflicts.length} 个文件冲突，已停止续跑（未写盘）`);
    } else if (result.status === 'ok') {
      setResumeConflict(null);
      setResumeNotice(`可续跑：从第 ${result.plan.step ?? '—'} 步（调用 ${result.plan.resumeFromCallId ?? '—'}）继续`);
    } else if (result.status === 'not_resumable') {
      setResumeNotice(result.reason);
    } else {
      setResumeNotice('run 不存在');
    }
  };

  if (!runId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <History size={28} className="text-text-tertiary" />
        <p className="text-sm font-medium text-text-primary">还没有可审计的运行</p>
        <p className="text-xs text-text-secondary">先发起一次任务；有文件改动后，这里会按步骤列出快照 diff。</p>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-bg-primary"
      data-render-ms={renderMs ?? undefined}
      data-visible-lines={Math.min(lines.length, VIEWPORT_HEIGHT / ROW_HEIGHT + 16)}
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <History size={14} className="text-accent" />
        <span className="text-sm font-medium text-text-primary">审计台</span>
        <span className="font-mono text-[11px] text-text-tertiary">{runId}</span>
        {renderMs != null && (
          <span className="text-[11px] text-text-tertiary" title="当前视图渲染耗时（requestAnimationFrame 实测）">
            渲染 {renderMs}ms
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-secondary hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          >
            <RefreshCw size={12} /> 刷新
          </button>
          <button
            type="button"
            onClick={() => void checkResume()}
            className="inline-flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-xs text-text-secondary hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <PlayCircle size={12} /> 续跑检查
          </button>
          <button
            ref={runUndoRef}
            type="button"
            onClick={(event) => requestUndo({ kind: 'run' }, event.currentTarget)}
            disabled={busy || !data?.undo.runAvailable}
            className="inline-flex items-center gap-1 rounded-md border border-danger px-1.5 py-0.5 text-xs text-danger hover:bg-danger hover:text-bg-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-40"
          >
            <Undo2 size={12} /> 撤销整个 run
          </button>
        </div>
      </div>

      {resumeNotice && (
        <p className="shrink-0 border-b border-border bg-bg-inset px-3 py-1 text-[11px] text-text-secondary" role="status">
          {resumeNotice}
        </p>
      )}
      {actionError && (
        <p className="shrink-0 border-b border-danger bg-danger-subtle px-3 py-1 text-[11px] text-danger" role="alert">
          {actionError}
        </p>
      )}

      {loading && (
        <div className="flex flex-1 items-center justify-center gap-2 text-xs text-text-secondary" role="status" aria-live="polite">
          <RefreshCw size={14} className="animate-spin" /> 正在加载审计数据…
        </div>
      )}

      {error && !loading && (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" role="alert">
          <p className="text-sm text-danger">审计数据加载失败</p>
          <p className="text-xs text-text-secondary">{error}</p>
          <button
            type="button"
            onClick={() => void load()}
            className="rounded border border-border px-2 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent"
          >
            重试
          </button>
        </div>
      )}

      {data && !loading && !error && (
        <div className="flex min-h-0 flex-1">
          {/* 文件树 */}
          <aside className="w-[220px] shrink-0 overflow-y-auto border-r border-border bg-bg-secondary p-2" aria-label="文件树">
            {data.files.length === 0 ? (
              <p className="p-2 text-xs text-text-tertiary">本次 run 没有文件改动。</p>
            ) : (
              <FileTree
                files={data.files}
                collapsed={collapsed}
                onToggle={(dir) => setCollapsed((prev) => ({ ...prev, [dir]: !prev[dir] }))}
                selected={selectedPath}
                onSelect={(path) => {
                  setSelected(path);
                  setScrollTop(0);
                  setOpenStep(null);
                }}
              />
            )}
          </aside>

          {/* diff 面板 */}
          <section className="flex min-w-0 flex-1 flex-col" aria-label="文件 diff">
            {selectedPath == null ? (
              <div className="flex flex-1 items-center justify-center text-xs text-text-tertiary">选择左侧文件查看 diff</div>
            ) : (
              <>
                <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
                  <FileText size={12} className="text-accent" />
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-text-primary">{selectedPath}</span>
                  {selectedFile?.operation === 'create' && (
                    <span className="shrink-0 rounded bg-accent-subtle px-1 text-[10px] text-accent">新增</span>
                  )}
                  {selectedFile && (
                    <span className="shrink-0 text-[11px] text-text-tertiary">
                      +{selectedFile.added} / -{selectedFile.removed}
                    </span>
                  )}
                  <button
                    type="button"
                    onClick={(event) => requestUndo({ kind: 'file', path: selectedPath }, event.currentTarget)}
                    disabled={busy}
                    className="inline-flex shrink-0 items-center gap-1 rounded border border-border px-1.5 py-0.5 text-[11px] text-text-secondary hover:border-danger hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-40"
                  >
                    <Undo2 size={11} /> 撤销该文件
                  </button>
                </div>

                <div
                  className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[18px]"
                  onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
                  data-testid="audit-diff-scroll"
                >
                  <div style={{ height: windowRange.totalHeight, position: 'relative' }}>
                    <div style={{ transform: `translateY(${windowRange.offsetTop}px)` }}>
                      {visible.map((line, index) => (
                        <div
                          key={`${windowRange.start + index}-${line.text.slice(0, 12)}`}
                          className={cn(
                            'flex h-[18px] items-center whitespace-pre',
                            line.kind === 'add' && 'bg-diff-add text-text-primary',
                            line.kind === 'del' && 'bg-diff-del text-text-primary',
                            line.kind === 'meta' && 'cursor-pointer bg-bg-inset text-accent',
                            line.kind === 'context' && 'text-text-secondary',
                          )}
                          onClick={() => {
                            if (line.kind === 'meta') setOpenStep(line.step);
                          }}
                          role={line.kind === 'meta' ? 'button' : undefined}
                          tabIndex={line.kind === 'meta' ? 0 : undefined}
                          onKeyDown={(event) => {
                            if (line.kind === 'meta' && (event.key === 'Enter' || event.key === ' ')) {
                              event.preventDefault();
                              setOpenStep(line.step);
                            }
                          }}
                        >
                          <span className="w-10 shrink-0 select-none px-2 text-text-tertiary">
                            {windowRange.start + index + 1}
                          </span>
                          <span className="min-w-0 flex-1 px-2">{line.text || ' '}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {openStep != null && (
                  <StepDetail
                    data={data}
                    step={openStep}
                    onClose={() => setOpenStep(null)}
                  />
                )}
              </>
            )}
          </section>
        </div>
      )}

      {pendingUndo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="undo-dialog-title"
            aria-describedby="undo-dialog-desc"
            data-testid="undo-confirm-dialog"
            onKeyDown={onDialogKeyDown}
            className="w-full max-w-sm rounded-lg border border-border bg-bg-primary p-4 shadow-xl"
          >
            <h3 id="undo-dialog-title" className="text-sm font-medium text-text-primary">
              确认撤销？
            </h3>
            <p id="undo-dialog-desc" className="mt-2 text-xs text-text-secondary">
              将恢复 {undoImpact.restore} 个文件、删除 {undoImpact.remove} 个新建文件。
            </p>
            {undoImpact.remove > 0 && (
              <p className="mt-1 text-[11px] text-text-tertiary">
                删除仅针对本 run 新建、且内容未被改动过的文件；你后来改过的会保留。
              </p>
            )}
            <p className="mt-1 text-[11px] text-text-tertiary">
              {pendingUndo.kind === 'run'
                ? '将按 run 内全部快照写回/删除，不影响其他文件。'
                : `只处理 ${pendingUndo.path}，不影响其他文件。`}
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                ref={cancelRef}
                type="button"
                onClick={cancelUndo}
                className="rounded border border-border px-3 py-1 text-xs text-text-secondary hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                取消
              </button>
              <button
                type="button"
                onClick={() => void confirmUndo()}
                disabled={undoImpact.restore === 0 && undoImpact.remove === 0}
                className="rounded border border-danger bg-danger px-3 py-1 text-xs text-bg-primary hover:bg-danger/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger disabled:opacity-40"
              >
                确认撤销
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function FileTree({
  files,
  collapsed,
  onToggle,
  selected,
  onSelect,
}: {
  files: RunAuditResponse['files'];
  collapsed: Record<string, boolean>;
  onToggle: (dir: string) => void;
  selected: string | null;
  onSelect: (path: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, typeof files>();
    for (const file of files) {
      const dir = file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : '.';
      const list = map.get(dir) ?? [];
      list.push(file);
      map.set(dir, list);
    }
    return [...map.entries()];
  }, [files]);

  return (
    <div className="space-y-1">
      {groups.map(([dir, items]) => (
        <div key={dir}>
          <button
            type="button"
            onClick={() => onToggle(dir)}
            aria-expanded={!collapsed[dir]}
            className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs text-text-secondary hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {collapsed[dir] ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            <Folder size={12} />
            <span className="min-w-0 truncate font-mono">{dir}</span>
          </button>
          {!collapsed[dir] && (
            <ul className="ml-4">
              {items.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => onSelect(file.path)}
                    aria-current={selected === file.path}
                    className={cn(
                      'flex w-full items-center gap-1 rounded px-1 py-0.5 text-left text-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
                      selected === file.path
                        ? 'bg-accent-subtle text-accent'
                        : 'text-text-secondary hover:text-accent',
                    )}
                  >
                    <FileText size={12} className="shrink-0" />
                    <span className="min-w-0 truncate font-mono">{file.path.split('/').pop()}</span>
                    {file.operation === 'create' && (
                      <span className="shrink-0 rounded bg-accent-subtle px-1 text-[10px] text-accent">新增</span>
                    )}
                    <span className="ml-auto shrink-0 text-[10px] text-text-tertiary">{file.steps.length} 次</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}

function StepDetail({
  data,
  step,
  onClose,
}: {
  data: RunAuditResponse;
  step: number;
  onClose: () => void;
}) {
  const info = data.steps.find((s) => s.step === step);
  const approvals = data.approvals.filter((a) => info?.toolCallIds.includes(String(a.callId ?? '')));
  return (
    <div className="shrink-0 border-t border-border bg-bg-inset p-2 text-[11px] text-text-secondary" role="region" aria-label="步骤详情">
      <div className="flex items-center gap-2">
        <span className="font-medium text-text-primary">第 {step} 步</span>
        <span className="font-mono text-text-tertiary">{info?.checkpointId}</span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded border border-border px-1.5 text-text-tertiary hover:text-accent"
        >
          关闭
        </button>
      </div>
      <div className="mt-1">调用：{info?.toolCallIds.join(', ') || '无'}</div>
      <div>快照：{info?.checkpointId ?? '—'}{info?.restoredAt ? `（已撤销于 ${new Date(info.restoredAt).toLocaleTimeString()}）` : ''}</div>
      <div className="mt-1">
        审批：{approvals.length === 0 ? '本步无审批记录' : approvals.map((a) => `${String(a.decision ?? '')}（${String(a.approvalMode ?? '')}）`).join('、')}
      </div>
    </div>
  );
}
