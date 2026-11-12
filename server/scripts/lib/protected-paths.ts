/**
 * 受保护路径的单一真相源。
 *
 * 之前 screen() 与 sourceFiles() 各持一份口径：提示词把 judge/ 等文件列进
 * 「可以改的清单」，机械闸又拒绝它们——模型被设局，提名注定作废。
 * 现在两处共用这一份常量：清单里出现的，闸一定放行；闸拒绝的，清单一定不列。
 */
export const PROTECTED_PATHS: readonly string[] = [
  'tests/',
  'krsi/',
  'src/services/judge/',
  'src/services/rsi/',
  'src/services/eval/',
  'scripts/',
];

export function isProtected(relPath: string): boolean {
  return PROTECTED_PATHS.some((prefix) => relPath.startsWith(prefix));
}