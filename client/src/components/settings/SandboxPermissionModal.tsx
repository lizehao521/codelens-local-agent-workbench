// 沙箱权限模态（运行时「沙箱权限」按钮打开）：放开沙箱外目录 + 免审批高危操作。
// 两种放宽都经服务端硬校验，并以持久化配置落地（PUT 后立即生效，无需重启）。
// 安全边界：越界与危险 URL 的硬拒绝不被豁免绕过（见 security-gateway.applyExemptions）。

import { useEffect, useMemo, useState } from 'react';
import { TriangleAlert, FolderOpen, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { Modal } from '../common/Modal';
import { cn } from '../../lib/cn';
import { useAsyncData } from '../../hooks/useAsyncData';
import {
  ApiError,
  getSandboxPermissions,
  updateSandboxPermissions,
  type SandboxPermissionConfig,
} from '../../services/api';

type AutoKey = 'fsDestructive' | 'purge' | 'httpWrite';

const AUTO_ITEMS: { key: AutoKey; label: string; description: string }[] = [
  { key: 'fsDestructive', label: '删除 / 覆盖文件', description: 'fs.write 的 delete、覆盖已存在文件（high/hard）免审批' },
  { key: 'purge', label: '清空目录', description: 'fs.write 的 purge 批量销毁（two_step）免审批' },
  { key: 'httpWrite', label: '外部状态写请求', description: 'http.request 的 POST/PUT/PATCH/DELETE（high/hard）免审批' },
];

export function SandboxPermissionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [config, setConfig] = useState<SandboxPermissionConfig | null>(null);
  const [newDir, setNewDir] = useState('');
  const [rejected, setRejected] = useState<Array<{ dir: string; error: string }>>([]);
  /**
   * 保存失败的原因。
   *
   * 与「加载失败」分开存：加载错误来自 useAsyncData（只读，hook 自己管），
   * 保存错误是本组件产生的副作用，二者会同时出现在界面上 —— 合成一个 state
   * 就必须让 hook 也暴露 setter，那会把「只读观测」变成「可写通道」。
   */
  const [saveError, setSaveError] = useState<string | null>(null);

  // 加载交给统一 hook：面板快速开合时的竞态处理与错误文案口径只此一处，
  // 此前这里是第 N 份手抄的「cancelled 标志位 + then/catch/finally」样板。
  const { data, error, loading } = useAsyncData(() => getSandboxPermissions(), [open], {
    enabled: open,
    errorMessage: '加载沙箱权限失败',
  });

  // 服务端配置落地到本地 state（保存成功后本地仍是最新的一份）。
  useEffect(() => {
    if (!data) return;
    setConfig({ allowDirs: [...data.allowDirs], autoApprove: { ...data.autoApprove } });
  }, [data]);

  // 打开时清掉上一次交互的残留：被拒目录与待添加目录都属于上一次会话。
  useEffect(() => {
    if (!open) return;
    setRejected([]);
    setNewDir('');
  }, [open]);

  const allowDirs = config?.allowDirs ?? [];
  const autoApprove = config?.autoApprove;

  const addDir = (): void => {
    const dir = newDir.trim();
    if (!dir || !config) return;
    if (allowDirs.includes(dir)) {
      setSaveError('该目录已在白名单中');
      return;
    }
    setConfig({ ...config, allowDirs: [...allowDirs, dir] });
    setNewDir('');
    setSaveError(null);
    setRejected([]);
  };

  const removeDir = (dir: string): void => {
    if (!config) return;
    setConfig({ ...config, allowDirs: allowDirs.filter((d) => d !== dir) });
    setRejected((r) => r.filter((x) => x.dir !== dir));
  };

  const toggleAuto = (key: AutoKey): void => {
    if (!config || !autoApprove) return;
    setConfig({ ...config, autoApprove: { ...autoApprove, [key]: !autoApprove[key] } });
  };

  const rejectedMap = useMemo(() => new Map(rejected.map((r) => [r.dir, r.error])), [rejected]);

  const save = async (): Promise<void> => {
    if (!config) return;
    setSaving(true);
    setSaveError(null);
    setRejected([]);
    try {
      await updateSandboxPermissions({ allowDirs: config.allowDirs, autoApprove: config.autoApprove });
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.rejected && err.rejected.length > 0) {
        setRejected(err.rejected);
        setSaveError('以下目录未通过服务端安全校验，已整体拒绝（未写入任何变更）');
      } else {
        setSaveError(err instanceof Error ? err.message : '保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="沙箱权限"
      maxWidth={560}
      footer={
        <>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:bg-bg-tertiary hover:text-text-primary"
          >
            取消
          </button>
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || loading || !config}
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-bg-primary transition-colors duration-150 hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? '保存中…' : '保存'}
          </button>
        </>
      }
    >
      {loading && <p className="py-6 text-center text-sm text-text-tertiary">加载中…</p>}

      {!loading && config && (
        <div className="space-y-5">
          {/* 安全提示 */}
          <p className="flex items-start gap-1.5 rounded bg-danger-subtle px-2.5 py-2 text-xs leading-relaxed text-danger">
            <ShieldAlert size={13} className="mt-0.5 shrink-0" />
            这是一次显式、持久化的放宽。放开目录与免审批都会降低沙箱隔离强度；越界路径与危险 URL 的硬拒绝仍生效，不可被绕过。
          </p>

          {/* 放开沙箱外目录 */}
          <section>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text-primary">
              <FolderOpen size={14} className="text-text-secondary" />
              放开沙箱外目录（白名单）
            </h3>
            <p className="mb-2 text-xs text-text-tertiary">
              仅这些目录（含子目录）内的绝对/相对路径可被文件工具读写。需为真实存在的绝对目录，且非系统敏感目录（如 C:\Windows、/etc），也非沙箱根及其上级。
            </p>

            <div className="mb-2 flex gap-1.5">
              <input
                value={newDir}
                onChange={(e) => setNewDir(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addDir();
                  }
                }}
                placeholder="例如 C:\Projects 或 /Users/me/data"
                className="min-w-0 flex-1 rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary outline-none transition-colors duration-150 placeholder:text-text-tertiary focus:border-accent"
              />
              <button
                type="button"
                onClick={addDir}
                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border px-2.5 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
              >
                <Plus size={14} />
                添加
              </button>
            </div>

            {allowDirs.length === 0 ? (
              <p className="rounded-md border border-border-subtle bg-bg-primary px-2.5 py-2 text-xs text-text-tertiary">
                暂无放开目录，文件工具仅可访问沙箱根内路径。
              </p>
            ) : (
              <ul className="space-y-1">
                {allowDirs.map((dir) => (
                  <li
                    key={dir}
                    className={cn(
                      'flex items-center justify-between gap-2 rounded-md border px-2.5 py-1.5',
                      rejectedMap.has(dir)
                        ? 'border-danger bg-danger-subtle'
                        : 'border-border-subtle bg-bg-primary',
                    )}
                  >
                    <span className="min-w-0 flex-1 break-all text-xs text-text-primary">{dir}</span>
                    {rejectedMap.has(dir) && (
                      <span className="shrink-0 text-xs text-danger" title={rejectedMap.get(dir)}>
                        {rejectedMap.get(dir)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => removeDir(dir)}
                      aria-label={`移除 ${dir}`}
                      className="shrink-0 rounded p-1 text-text-tertiary transition-colors duration-150 hover:bg-bg-tertiary hover:text-danger"
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* 免审批高危操作 */}
          <section>
            <h3 className="mb-1.5 text-sm font-medium text-text-primary">免审批（自动放行高危操作）</h3>
            <p className="mb-2 text-xs text-text-tertiary">
              开启后，对应高危操作不再弹出审批条，直接执行。仅降级「是否确认」，不绕过越界与 SSRF 硬拒绝。
            </p>
            <div className="space-y-1.5">
              {AUTO_ITEMS.map((item) => (
                <Toggle
                  key={item.key}
                  checked={autoApprove ? autoApprove[item.key] : false}
                  onChange={() => toggleAuto(item.key)}
                  label={item.label}
                  description={item.description}
                />
              ))}
            </div>
          </section>

          {(saveError ?? error) && (
            <p className="flex items-start gap-1.5 rounded bg-danger-subtle px-2.5 py-2 text-xs leading-relaxed text-danger">
              <TriangleAlert size={13} className="mt-0.5 shrink-0" />
              {saveError ?? error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  description: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={onChange}
      className="flex w-full items-center justify-between gap-3 rounded-md border border-border bg-bg-primary px-3 py-2.5 text-left transition-colors duration-150 hover:border-accent"
    >
      <span className="min-w-0">
        <span className="block text-sm text-text-primary">{label}</span>
        <span className="block text-xs text-text-tertiary">{description}</span>
      </span>
      <span
        className={cn(
          'relative h-5 w-9 shrink-0 rounded-full transition-colors duration-150',
          checked ? 'bg-accent' : 'bg-bg-tertiary',
        )}
      >
        <span
          className={cn(
            'absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all duration-150',
            checked ? 'left-4' : 'left-0.5',
          )}
        />
      </span>
    </button>
  );
}
