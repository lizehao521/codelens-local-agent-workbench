// 设置分区 ③ —— MCP 连接器（P1）：stdio server 增删改 + 连接/断开 + 工具清单
// AC-12：未连接的 server 其工具不进入下发清单（模型不可见）—— 由服务端注册表保证

import { useCallback, useEffect, useState } from 'react';
import { Loader, Plug, PlugZap, Plus, Trash2 } from 'lucide-react';
import type { McpServer, McpServerStatus } from '../../types';
import {
  connectMcpServer,
  createMcpServer,
  deleteMcpServer,
  disconnectMcpServer,
  listMcpServers,
} from '../../services/api';
import { useUiStore } from '../../stores/uiStore';
import { Field } from './FormControls';
import { cn } from '../../lib/cn';

const STATUS_META: Record<McpServerStatus, { label: string; className: string }> = {
  disconnected: { label: '未连接', className: 'text-text-tertiary' },
  connecting: { label: '连接中', className: 'text-accent' },
  connected: { label: '已连接', className: 'text-success' },
  failed: { label: '连接失败', className: 'text-danger' },
};

interface DraftServer {
  name: string;
  command: string;
  args: string;
  env: string;
}

const EMPTY_DRAFT: DraftServer = { name: '', command: '', args: '', env: '' };

export function McpZone() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState<DraftServer | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const pushToast = useUiStore((s) => s.pushToast);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      const data = await listMcpServers();
      setServers(data.servers);
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : 'MCP 列表加载失败', variant: 'error' });
    } finally {
      setLoading(false);
    }
  }, [pushToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleCreate = async (): Promise<void> => {
    if (!draft) return;
    const name = draft.name.trim();
    const command = draft.command.trim();
    if (!name || !command) {
      setDraftError('名称与启动命令必填');
      return;
    }
    let env: Record<string, string> = {};
    if (draft.env.trim()) {
      try {
        const parsed = JSON.parse(draft.env) as unknown;
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('bad');
        env = parsed as Record<string, string>;
      } catch {
        setDraftError('env 必须是 JSON 对象，如 {"KEY":"value"}');
        return;
      }
    }
    setDraftError(null);
    try {
      await createMcpServer({
        name,
        command,
        args: draft.args.split('\n').map((s) => s.trim()).filter(Boolean),
        env,
      });
      setDraft(null);
      pushToast({ message: '已添加 MCP Server', variant: 'success' });
      await load();
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : '添加失败');
    }
  };

  const handleConnect = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await connectMcpServer(id);
      await load();
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '连接失败', variant: 'error' });
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleDisconnect = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await disconnectMcpServer(id);
      await load();
    } finally {
      setBusyId(null);
    }
  };

  const handleDelete = async (id: string): Promise<void> => {
    setBusyId(id);
    try {
      await deleteMcpServer(id);
      await load();
      pushToast({ message: '已删除', variant: 'info' });
    } catch (err) {
      pushToast({ message: err instanceof Error ? err.message : '删除失败', variant: 'error' });
    } finally {
      setBusyId(null);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-text-secondary">
        <Loader size={14} className="animate-spin" /> 加载 MCP 配置…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-text-tertiary">
        MCP Server 以 stdio 方式按需启动。未连接时其工具不会下发给模型；连接后工具以
        <span className="mx-1 font-mono">mcp.&lt;server&gt;.&lt;tool&gt;</span>
        规范名注册。
      </p>

      {servers.length === 0 && !draft && <p className="text-sm text-text-secondary">还没有配置 MCP Server。</p>}

      <ul className="space-y-2">
        {servers.map((server) => {
          const meta = STATUS_META[server.status];
          const busy = busyId === server.id;
          return (
            <li key={server.id} className="rounded-md border border-border-subtle bg-bg-primary p-2.5">
              <div className="flex items-center gap-2">
                <Plug size={14} className="shrink-0 text-text-secondary" />
                <span className="min-w-0 flex-1 truncate text-sm font-medium text-text-primary">{server.name}</span>
                <span className={cn('shrink-0 text-xs', meta.className)}>{meta.label}</span>
                {server.status === 'connected' ? (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleDisconnect(server.id)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    断开
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void handleConnect(server.id)}
                    className="shrink-0 rounded border border-border px-1.5 py-0.5 text-xs text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent disabled:opacity-50"
                  >
                    连接
                  </button>
                )}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void handleDelete(server.id)}
                  aria-label={`删除 ${server.name}`}
                  className="shrink-0 rounded p-1 text-text-tertiary transition-colors duration-150 hover:bg-danger-subtle hover:text-danger disabled:opacity-50"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              <p className="mt-1 truncate font-mono text-xs text-text-tertiary" title={`${server.command} ${server.args.join(' ')}`}>
                {server.command} {server.args.join(' ')}
              </p>
              {server.status === 'connected' && server.tools.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {server.tools.map((tool) => (
                    <span key={tool} className="rounded bg-bg-inset px-1.5 py-0.5 font-mono text-xs text-text-secondary">
                      {tool}
                    </span>
                  ))}
                </div>
              )}
              {server.lastError && <p className="mt-1 text-xs text-danger">{server.lastError}</p>}
            </li>
          );
        })}
      </ul>

      {draft ? (
        <div className="space-y-2 rounded-md border border-border bg-bg-primary p-2.5">
          <Field label="名称">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              placeholder="my-server"
              className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 text-sm text-text-primary focus:border-accent"
            />
          </Field>
          <Field label="启动命令" hint="不允许 shell 元字符；以 spawn(shell:false) 执行">
            <input
              value={draft.command}
              onChange={(e) => setDraft({ ...draft, command: e.target.value })}
              placeholder="npx"
              className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-sm text-text-primary focus:border-accent"
            />
          </Field>
          <Field label="参数" hint="每行一个">
            <textarea
              value={draft.args}
              onChange={(e) => setDraft({ ...draft, args: e.target.value })}
              rows={2}
              placeholder={'-y\n@modelcontextprotocol/server-everything'}
              className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-sm text-text-primary focus:border-accent"
            />
          </Field>
          <Field label="环境变量" hint="JSON 对象；键名不得含 apiKey/token/secret 等">
            <input
              value={draft.env}
              onChange={(e) => setDraft({ ...draft, env: e.target.value })}
              placeholder='{"DEBUG":"1"}'
              className="w-full rounded-md border border-border bg-bg-primary px-2.5 py-1.5 font-mono text-sm text-text-primary focus:border-accent"
            />
          </Field>
          {draftError && <p className="text-xs text-danger">{draftError}</p>}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => void handleCreate()}
              className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-text-on-accent transition-colors duration-150 hover:bg-accent-hover"
            >
              添加
            </button>
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setDraftError(null);
              }}
              className="rounded border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:border-accent"
            >
              取消
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
          className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-sm text-text-secondary transition-colors duration-150 hover:border-accent hover:text-accent"
        >
          <Plus size={14} />
          添加 MCP Server
        </button>
      )}

      <p className="flex items-center gap-1.5 text-xs text-text-tertiary">
        <PlugZap size={12} />
        MCP 为 P1 能力：连接器界面已就绪，未连接不影响内置工具。
      </p>
    </div>
  );
}
