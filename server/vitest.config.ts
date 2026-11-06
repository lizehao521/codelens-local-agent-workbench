import { configDefaults, defineConfig } from 'vitest/config';

/**
 * 测试并发配置。
 *
 * 为什么需要它：本仓库的用例里有**真实进程 spawn**（`sys.exec` 要起子进程，
 * 超时后还要等进程组被杀干净——本机 `taskkill` 到 close 约 11 秒）。默认的
 * 「按 CPU 核数无限制开 worker」在 64 个测试文件下会把 CPU 占满，
 * 于是纯计算用例（`expression-parser` 正常只需几毫秒）也会被饿到 5s 超时，
 * 表现为「一堆与改动无关的测试失败」。
 *
 * 这不是把测试改松，而是把并发降到机器真能承载的水平：
 * 每个 worker 拿得到 CPU，超时就只在真的卡住时发生。
 */
export default defineConfig({
  test: {
    // tsc 会把 src 下的 *.test.ts 一并编译进 dist/；不排除的话 vitest 会把
    // 同一批用例按 src 和 dist 各跑一遍（文件数虚增、耗时翻倍，且 dist 还是
    // 旧构建时会给出误导性结论）。在默认排除项之上显式追加 dist。
    exclude: [...configDefaults.exclude, '**/dist/**'],
    // 2 个 worker：与 4 个相比，单个 worker 拿到的 CPU 更充裕，hook 不再超时。
    //
    // 为什么从 4 降到 2：本仓库 80 个测试文件，每个文件都要 spawn 一个 worker
    // （实测启动 ≈12.7s/个）。当**另一轮全量测试并行占用 CPU** 时，worker 启动
    // 会显著变慢，于是 hook 在 20s 内起不来 → 报「Hook timed out」——
    // 失败信息指向"某个文件没跑起来"，而不是"某条断言不成立"，极易误判为回归。
    // 把并发降到机器真能承载的水平，超时就只在真的卡住时发生。
    maxWorkers: 2,
    // 含 spawn 的用例（sys-exec 的超时/进程组场景）单条就要 15s+，
    // 文件级已各自声明 timeout；这里只把默认值抬到不至于误杀集成测试的水平。
    testTimeout: 60_000,
    // hookTimeout 必须大于「worker 启动 + 排队」的耗时：
    // 高负载下 worker 启动实测可达 30s+，20s 的默认值必然误杀。
    hookTimeout: 90_000,
  },
});
