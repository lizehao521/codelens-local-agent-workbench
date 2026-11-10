// AgentMessageList —— 消息流容器：自动滚动（用户上滚时暂停跟随）+ 流式锚点
// 性能：列表按消息订阅；工具卡内部自订阅 byId，列表本体不随 tool 事件重渲染。

import { useEffect, useRef } from 'react';
import type { SessionMessageRow } from '../../types';
import { useUiStore } from '../../stores/uiStore';
import { AgentMessageItem } from './AgentMessageItem';

export interface AgentMessageListProps {
  messages: SessionMessageRow[];
  onRetryStep?: (callId: string) => void;
  onRerunFrom?: (callId: string) => void;
  busy?: boolean;
  /** 空态占位（无消息时） */
  empty?: React.ReactNode;
}

export function AgentMessageList({ messages, onRetryStep, onRerunFrom, busy, empty }: AgentMessageListProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);
  const lastCountRef = useRef(0);
  // 状态栏「跳到最新」：nonce 变化即恢复跟随并锚底
  const chatScrollNonce = useUiStore((s) => s.chatScrollNonce);

  // 用户上滚超过阈值则暂停跟随；滚回底部恢复
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = (): void => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinnedRef.current = distance < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // 新消息 / 流式增长时锚底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const growth = messages.length !== lastCountRef.current;
    lastCountRef.current = messages.length;
    if (!pinnedRef.current && !growth) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  // 「跳到最新」：重新启用自动跟随并滚到底
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = true;
    el.scrollTop = el.scrollHeight;
  }, [chatScrollNonce]);

  if (messages.length === 0 && empty) {
    return <div className="min-h-0 flex-1 overflow-y-auto">{empty}</div>;
  }

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      {messages.map((message) => (
        <AgentMessageItem
          key={message.id}
          message={message}
          onRetryStep={onRetryStep}
          onRerunFrom={onRerunFrom}
          busy={busy}
        />
      ))}
    </div>
  );
}
