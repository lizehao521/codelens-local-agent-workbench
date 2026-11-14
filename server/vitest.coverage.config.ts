import { mergeConfig } from 'vitest/config';
import base from './vitest.config';

/**
 * 覆盖率专用配置 —— 只在 `npm run test:coverage` 时使用。
 *
 * 为什么不直接改 vitest.config.ts：那份是围栏的受保护件（改它=改尺子）。
 * 这里 mergeConfig 继承它的全部执行语义（exclude / maxWorkers / 超时），
 * 只叠加 coverage 一段，所以覆盖率轮与常规轮的用例行为完全一致 ——
 * 实测两轮的文件数与通过数必须相同，不同就说明插桩改变了行为，那是缺陷不是读数。
 *
 * include 显式给 src/**：默认口径只统计「被测试碰过的文件」，那会让一个
 * 从没被测过的模块凭空消失，分母缩小后百分比虚高。
 */
export default mergeConfig(base, {
  test: {
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      reporter: ['text', 'json-summary'],
      reportsDirectory: 'coverage',
    },
  },
});