/**
 * judge-run-badges —— 判决历史的公共小件（色调 / 中文标签 / 三态图标）。
 *
 * 从 JudgePanelModal 抽出，两个理由：
 *   1. modal 行数已被棘轮钉在 650，趋势 tab 需要腾出空间；
 *   2. 判决语义的「中文名」必须只有一处定义 —— 两处各写一份必然分叉
 *      （此前 statusLabel('unexec') 被画成「通过」就是这么来的）。
 */

import { CircleCheckBig, CircleX, HelpCircle } from 'lucide-react';
import type { JudgeRunVerdict, JudgeVerdictStatus } from '../../services/api';

export function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export function runTone(verdict: JudgeRunVerdict): string {
  if (verdict === 'pass') return 'text-success';
  if (verdict === 'fail') return 'text-danger';
  return 'text-warning';
}

export function runLabel(verdict: JudgeRunVerdict): string {
  if (verdict === 'pass') return '通过';
  if (verdict === 'fail') return '失败';
  return '未定论';
}

export function VerdictIcon({ status }: { status: JudgeVerdictStatus }) {
  if (status === 'pass') return <CircleCheckBig size={12} className="shrink-0 text-success" />;
  if (status === 'fail') return <CircleX size={12} className="shrink-0 text-danger" />;
  return <HelpCircle size={12} className="shrink-0 text-text-tertiary" />;
}