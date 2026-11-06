/** time.now — current time with formatting, timezone shift and offset days. */

import type { ToolDefinition } from '../../types/tool.js';

const pad = (value: number, width = 2): string => String(Math.abs(value)).padStart(width, '0');

export const timeNowTool: ToolDefinition = {
  name: 'time.now',
  wireName: 'time_now',
  displayName: '当前时间',
  category: 'compute',
  description:
    '获取当前日期时间。支持 format（格式串：YYYY MM DD HH mm ss SSS，缺省 ISO 8601）、timezone（"UTC" 或 "local"）、offsetDays（前后偏移天数）、from（ISO 时间戳，换算该时刻）。',
  inputSchema: {
    type: 'object',
    properties: {
      format: { type: 'string', description: '格式串，如 "YYYY-MM-DD HH:mm:ss"', maxLength: 64 },
      timezone: { type: 'string', description: '"UTC" 或 "local"，缺省 local', maxLength: 64 },
      offsetDays: { type: 'number', description: '相对当前日期的偏移天数', minimum: -36500, maximum: 36500 },
      from: { type: 'string', description: 'ISO 8601 时间戳，换算该时刻而非当前时刻', maxLength: 40 },
    },
    additionalProperties: false,
  },
  timeoutMs: 5000,
  risk: 'low',
  approvalMode: 'none',
  source: 'builtin',
  idempotent: true,
  maxResultChars: 2000,
  enabled: () => true,
  handler: async (args) => {
    const zone = String(args.timezone ?? 'local').trim();
    if (zone !== 'local' && zone.toUpperCase() !== 'UTC' && zone.toUpperCase() !== 'GMT') {
      return {
        ok: false,
        summary: 'timezone 只支持 "UTC" 或 "local"',
        error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'timezone 只支持 "UTC" 或 "local"' },
      };
    }
    const useUtc = zone.toUpperCase() === 'UTC' || zone.toUpperCase() === 'GMT';

    let date = new Date();
    if (args.from !== undefined) {
      const parsed = new Date(String(args.from));
      if (Number.isNaN(parsed.getTime())) {
        return {
          ok: false,
          summary: 'from 不是合法的 ISO 8601 时间戳',
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'from 不是合法的 ISO 8601 时间戳' },
        };
      }
      date = parsed;
    }
    if (args.offsetDays !== undefined) {
      const days = Number(args.offsetDays);
      if (!Number.isFinite(days)) {
        return {
          ok: false,
          summary: 'offsetDays 必须是数字',
          error: { code: 'TOOL_INVALID_ARGS', kind: 'invalid_args', message: 'offsetDays 必须是数字' },
        };
      }
      date = new Date(date.getTime() + days * 86400000);
    }

    const tokens = {
      YYYY: pad(useUtc ? date.getUTCFullYear() : date.getFullYear(), 4),
      MM: pad((useUtc ? date.getUTCMonth() : date.getMonth()) + 1),
      DD: pad(useUtc ? date.getUTCDate() : date.getDate()),
      HH: pad(useUtc ? date.getUTCHours() : date.getHours()),
      mm: pad(useUtc ? date.getUTCMinutes() : date.getMinutes()),
      ss: pad(useUtc ? date.getUTCSeconds() : date.getSeconds()),
      SSS: pad(useUtc ? date.getUTCMilliseconds() : date.getMilliseconds(), 3),
    };
    const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
    const weekday = weekdayNames[useUtc ? date.getUTCDay() : date.getDay()]!;
    const format = args.format === undefined ? null : String(args.format);
    const formatted = format
      ? format.replace(/YYYY|MM|DD|HH|mm|ss|SSS/g, (token) => tokens[token as keyof typeof tokens] ?? token)
      : `${tokens.YYYY}-${tokens.MM}-${tokens.DD}T${tokens.HH}:${tokens.mm}:${tokens.ss}.${tokens.SSS}${useUtc ? 'Z' : ''}`;

    return {
      ok: true,
      summary: `${formatted}（星期${weekday}）`,
      data: {
        iso: date.toISOString(),
        formatted,
        timezone: useUtc ? 'UTC' : 'local',
        epochMs: date.getTime(),
        weekday,
      },
    };
  },
};
