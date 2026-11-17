// 设置分区 ④ —— 安全边界（只读展示）：这些阈值由服务端锁定，前端改不动也不该改
// 展示口径与 spec §10 / 架构 §7.6 一致：HTTP 白名单、文件 jail、超时、重试预算、轮次上限

import { FileLock, Globe, ShieldCheck, Timer } from 'lucide-react';

interface BoundaryRow {
  label: string;
  value: string;
  note: string;
}

const HTTP_ROWS: BoundaryRow[] = [
  { label: '协议', value: '仅 https', note: 'http 需服务端 HTTP_ALLOW_INSECURE=true' },
  { label: '解析校验', value: 'DNS 解析后逐条校验', note: '任一记录命中禁用网段即拒绝（防 DNS  Rebinding）' },
  { label: '连接固定', value: '只用已校验 IP 建连', note: '不重新解析，消除 TOCTOU 窗口' },
  { label: '重定向', value: '逐跳复验，≤3 跳', note: '每跳重跑完整五重校验' },
  { label: '内嵌凭据', value: '拒绝', note: 'URL 中 user:pass@ 形式直接拦截' },
];

const FS_ROWS: BoundaryRow[] = [
  { label: '根目录', value: '服务端 SANDBOX_ROOT', note: '相对路径解析，绝对路径与 .. 段直接拒绝' },
  { label: '符号链接', value: 'realpath 后判定', note: '存在时 realpath 文件；写入时 realpath 最近祖先' },
  { label: '保留设备名', value: '拒绝', note: 'CON/PRN/AUX/NUL/COM1-9/LPT1-9 及尾空格点' },
];

const BUDGET_ROWS: BoundaryRow[] = [
  { label: '单工具超时', value: '30s 上限', note: 'fs/http 30s；calc/time 等即时工具 5s' },
  { label: '任务重试预算', value: '5 次 / 任务', note: '网络类仅幂等操作自动重试一次' },
  { label: '每工具熔断', value: '连续 3 次失败', note: '第 4 次直接返回熔断提示，不触发 LLM 调用' },
  { label: '循环检测', value: '同名同参 2 次警告 / 3 次中止', note: '警告注入上下文，不消耗重试预算' },
  { label: '最大轮次', value: '12 轮（可调 5-30）', note: '达到上限输出未完成项，不静默截断' },
  { label: '上下文压缩', value: '占用 >75% 触发', note: '三层压缩 + 九段摘要 + 保真自检，失败回退不截断' },
];

export function SecurityZone() {
  return (
    <div className="space-y-5">
      <BoundaryGroup icon={Globe} title="HTTP 出口（SSRF 五重校验）" rows={HTTP_ROWS} />
      <BoundaryGroup icon={FileLock} title="文件系统（沙箱 jail）" rows={FS_ROWS} />
      <BoundaryGroup icon={Timer} title="执行预算与熔断" rows={BUDGET_ROWS} />
      <p className="flex items-start gap-1.5 rounded bg-bg-inset p-2.5 text-xs text-text-secondary">
        <ShieldCheck size={13} className="mt-0.5 shrink-0 text-success" />
        以上阈值由服务端统一执行（安全网关是唯一策略点），本页只读、不可关闭。若需访问沙箱外目录或免审批高危操作，
        可在工作台顶栏「沙箱权限」中显式放开——该放宽为持久化配置，且仅降级「是否确认」，
        越界路径与危险 URL 的硬拒绝仍生效，不可被绕过。
      </p>
    </div>
  );
}

function BoundaryGroup({
  icon: Icon,
  title,
  rows,
}: {
  icon: typeof Globe;
  title: string;
  rows: BoundaryRow[];
}) {
  return (
    <section>
      <h3 className="mb-1.5 flex items-center gap-1.5 text-sm font-medium text-text-primary">
        <Icon size={14} className="text-text-secondary" />
        {title}
      </h3>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-baseline justify-between gap-3 rounded-md border border-border-subtle bg-bg-primary px-2.5 py-1.5"
          >
            <span className="shrink-0 text-xs text-text-tertiary">{row.label}</span>
            <span className="min-w-0 flex-1 text-right">
              <span className="block text-xs text-text-primary">{row.value}</span>
              <span className="block text-xs text-text-tertiary">{row.note}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
