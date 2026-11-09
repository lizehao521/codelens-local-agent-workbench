import { describe, it, expect } from "vitest";
import { httpRequestTool } from "../src/tools/builtin/http-request.tool.js";
import { evaluateExecCommand, execRequiresTwoStep } from "../src/tools/builtin/sys-exec.policy.js";

const ctx = { sandboxRoot: process.cwd() } as any;

describe("behavior-io", () => {
  it("httpRequestTool rejects invalid method with TOOL_INVALID_ARGS", async () => {
    const res = await httpRequestTool.handler({ url: "http://example.com", method: "FOO" }, ctx);
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("TOOL_INVALID_ARGS");
  });

  it("evaluateExecCommand denies rm -rf / with SECURITY_DENIED", () => {
    const res = evaluateExecCommand("rm", ["-rf", "/"]);
    expect(res.ok).toBe(false);
    expect(res.code).toBe("SECURITY_DENIED");
  });

  it("evaluateExecCommand allows git status when git is whitelisted", () => {
    const res = evaluateExecCommand("git", ["status"], ["git", "node"]);
    expect(res.ok).toBe(true);
  });

  it("execRequiresTwoStep: node requires two-step, git status does not", () => {
    expect(execRequiresTwoStep("node", [])).toBe(true);
    expect(execRequiresTwoStep("git", ["status"])).toBe(false);
  });
});
