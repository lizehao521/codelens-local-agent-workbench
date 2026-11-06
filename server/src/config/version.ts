/**
 * 产品版本号的唯一读取点。
 *
 * 之前 health 端点把 `'2.0.0'` 写死在代码里，而根 / server / client 三个
 * package.json 还是 `1.0.0` —— 于是「仓库里写的版本」「装出来的安装包版本」
 * 「健康检查自报的版本」三件事互相对不上，而且改版本要改代码。
 *
 * 现在版本只在 package.json 里定义一次，代码读它；一致性由
 * `tests/version-consistency.test.ts` 守住，而不是靠人记得同步。
 *
 * 运行形态有三种，锚点必须分别对待（曾漏掉第三种）：
 *  - ESM 源码 `src/config/version.ts` → 上两级 = `server/package.json`
 *  - 编译产物 `dist/config/version.js` → 上两级同样是 `server/package.json`
 *  - esbuild 打成的 CJS 单文件 `desktop/server-bundle.cjs`（桌面端）：
 *    esbuild 会把 `import.meta` 替换成空对象，`import.meta.url` 变成 undefined。
 *    曾在模块顶层直接用 import.meta.url 构造 require 锚点，桌面端一加载就抛
 *    ERR_INVALID_ARG_VALUE，表现为「版本启动错误」。
 *
 * CJS 形态的候选：bundle 同目录的 package.json（打包后即 app.asar/package.json，
 * electron-builder 的 files 含它）、上一级（开发态仓库根）。四个包的版本由
 * `tests/version-consistency.test.ts` 锁死一致，读哪一份都是同一个版本号。
 * 版本读取失败一律退化成 '0.0.0'（由该用例发现），绝不阻断服务启动。
 */
import { createRequire } from 'node:module';

interface PackageManifest {
  version?: string;
}

/**
 * 按运行形态解析版本号。两个锚点由调用方显式给出（不用默认参数）——
 * 这样回归用例传 undefined 就能真实模拟「该形态下锚点缺失」，不会被默认值
 * 悄悄换回 ESM 分支。真实运行时的探测只在 APP_VERSION 处做一次。
 */
export function resolveVersion(moduleUrl: string | undefined, cjsFilename: string | undefined): string {
  const anchor = moduleUrl ?? cjsFilename ?? process.argv[1];
  if (!anchor) return '0.0.0';

  const candidates = moduleUrl
    ? ['../../package.json']
    : ['./package.json', '../package.json', '../../package.json'];

  try {
    const require = createRequire(anchor);
    for (const candidate of candidates) {
      try {
        const version = (require(candidate) as PackageManifest).version;
        if (version) return version;
      } catch {
        // 该形态下这份 manifest 不存在，换下一个候选
      }
    }
  } catch {
    // 锚点无效（既非 ESM 也非 CJS）：版本读取失败不应阻断服务启动
  }
  return '0.0.0';
}

export const APP_VERSION: string = resolveVersion(
  import.meta.url,
  typeof __filename === 'string' ? __filename : undefined,
);
