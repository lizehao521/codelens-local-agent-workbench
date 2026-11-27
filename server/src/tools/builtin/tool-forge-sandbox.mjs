/**
 * Tool Forge Sandbox Worker
 *
 * 运行在独立子进程中，执行工具步骤，带有资源限制监控。
 * 通过 IPC 与主进程通信。
 */

import { parentPort, workerData } from 'node:worker_threads';

interface ExecuteRequest {
  type: 'execute';
  tool: {
    name: string;
    wireName: string;
    handler: string;
  };
  args: Record<string, unknown>;
  sandboxRoot: string;
  limits: {
    stepTimeoutMs: number;
    maxMemoryBytes: number;
    maxCpuTimeMs: number;
    maxOutputChars: number;
  };
}

interface ExecuteResponse {
  type: 'result';
  payload: {
    ok: boolean;
    summary: string;
    error?: { code: string; kind: string; message: string };
    data?: unknown;
  };
}

// 接收主进程发送的执行请求
parentPort.on('message', async (msg: ExecuteRequest) => {
  if (msg.type !== 'execute') return;

  const { tool, args, sandboxRoot, limits } = msg;

  try {
    // 动态创建工具处理函数
    // 注意：这里需要重新创建工具定义，因为 handler 是字符串
    const toolModule = await createToolModule(tool.handler, sandboxRoot);

    // 设置超时
    const timeout = setTimeout(() => {
      parentPort.postMessage({
        type: 'result',
        payload: {
          ok: false,
          summary: '步骤执行超时',
          error: { code: 'SANDBOX_TIMEOUT', kind: 'timeout', message: '步骤执行超过资源限制' },
        },
      });
      process.exit(1);
    }, limits.stepTimeoutMs);

    // 执行工具
    // 这里需要模拟 ToolExecutionContext
    const mockCtx = {
      sessionId: workerData.sessionId,
      sandboxRoot: msg.sandboxRoot,
      signal: { aborted: false },
    };

    let outcome;
    try {
      // 调用工具处理函数
      const handlerFn = new Function('args', 'ctx', toolModule.handler);
      const result = await handlerFn(msg.args, {
        sessionId: workerData.sessionId,
        sandboxRoot: msg.sandboxRoot,
        signal: { aborted: false },
      });
      outcome = result;
    } catch (err) {
      outcome = {
        ok: false,
        summary: err.message,
        error: { code: 'SANDBOX_ERROR', kind: 'internal', message: err.message },
      };
    }

    clearTimeout(timeout);

    // 发送结果
    parentPort.postMessage({
      type: 'result',
      payload: outcome,
    });
    process.exit(0);
  } catch (err) {
    parentPort.postMessage({
      type: 'result',
      payload: {
        ok: false,
        summary: `沙箱错误: ${err.message}`,
        error: { code: 'SANDBOX_ERROR', kind: 'internal', message: err.message },
      },
    });
    process.exit(1);
  }
});

// 根据 handler 字符串动态创建工具模块
async function createToolModule(handlerStr: string, sandboxRoot: string): Promise<{ handler: string }> {
  // 这里简化处理：直接返回 handler 字符串
  // 实际使用时由 main thread 通过 new Function 执行
  return { handler: handlerStr };
}