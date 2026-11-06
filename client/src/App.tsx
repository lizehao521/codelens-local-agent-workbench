// 应用根部（v2.0）—— 主题 + 服务端会话列表初始化 + provider 列表 + 多标签同步 + Toast 容器

import { useEffect } from 'react';
import { AppShell } from './components/layout/AppShell';
import { ToastContainer } from './components/common/Toast';
import { useTheme } from './hooks/useTheme';
import { useServerSessionStore } from './stores/serverSessionStore';
import { useSettingsStore } from './stores/settingsStore';
import { onStorageChange } from './lib/storage';

/** UI 轮询间隔：仅刷新 UI（重新拉 /providers），不重复打上游。默认 5 分钟。 */
const UI_POLL_MS = 5 * 60 * 1000;

export default function App() {
  useTheme();

  useEffect(() => {
    // 服务端会话列表（SQLite 是唯一事实源）；失败时侧栏展示错误可重试
    void useServerSessionStore.getState().loadList();
    // provider / 模型列表：启动静默刷新一次（失败则用 settingsStore 内置兜底注册表）；
    // 之后定时轮询，仅用于在服务端已同步上游模型后刷新 UI（不重复打上游）。
    void useSettingsStore.getState().refreshProviders(false);
    const id = setInterval(() => {
      void useSettingsStore.getState().refreshProviders(false);
    }, UI_POLL_MS);
    // 多标签同步：设置变更（主题等）以磁盘为准
    const off = onStorageChange(() => undefined);
    return () => {
      clearInterval(id);
      off();
    };
  }, []);

  return (
    <>
      <AppShell />
      <ToastContainer />
    </>
  );
}
