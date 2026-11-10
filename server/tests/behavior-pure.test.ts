import { describe, it, expect } from "vitest";
import { calcEvaluateTool } from "../src/tools/builtin/calc-evaluate.tool.js";
import { jsonFormatTool } from "../src/tools/builtin/json-format.tool.js";
import { textDiffTool } from "../src/tools/builtin/text-diff.tool.js";

const ctx = { sandboxRoot: process.cwd() } as any;

describe("behavior-pure", () => {
  it("calcEvaluateTool: 1+1 → decimal 2, base 10", async () => {
    const res = await calcEvaluateTool.handler({ expression: "1+1" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.data.decimal).toBe(2);
    expect(res.data.base).toBe(10);
  });

  it("jsonFormatTool: pretty → output 字符串且深度等于 {b:1,a:2}", async () => {
    const res = await jsonFormatTool.handler(
      { input: '{"b":1,"a":2}', mode: "pretty" },
      ctx,
    );
    expect(res.ok).toBe(true);
    expect(typeof res.data.output).toBe("string");
    expect(JSON.parse(res.data.output)).toEqual({ b: 1, a: 2 });
  });

  it("textDiffTool: a\\nb vs a\\nc → additions 1, deletions 1, identical false", async () => {
    const res = await textDiffTool.handler({ left: "a\nb", right: "a\nc" }, ctx);
    expect(res.ok).toBe(true);
    expect(res.data.additions).toBe(1);
    expect(res.data.deletions).toBe(1);
    expect(res.data.identical).toBe(false);
  });
});
