// 类名合并工具（不引入 clsx，保持零依赖）
export type ClassValue = string | false | null | undefined;

export function cn(...values: ClassValue[]): string {
  let out = '';
  for (const v of values) {
    if (!v) continue;
    out = out ? `${out} ${v}` : v;
  }
  return out;
}
