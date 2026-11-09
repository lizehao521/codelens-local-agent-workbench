import { describe, it, expect } from "vitest";
import { calcEvaluateTool } from "../src/tools/builtin/calc-evaluate.tool.js";
import { jsonFormatTool } from "../src/tools/builtin/json-format.tool.js";
import { uuidGenerateTool } from "../src/tools/builtin/uuid-generate.tool.js";
import { timeNowTool } from "../src/tools/builtin/time-now.tool.js";
import { textDiffTool } from "../src/tools/builtin/text-diff.tool.js";
import { fsReadTool } from "../src/tools/builtin/fs-read.tool.js";
import { fsWriteTool } from "../src/tools/builtin/fs-write.tool.js";
import { fsListTool } from "../src/tools/builtin/fs-list.tool.js";
import { httpRequestTool } from "../src/tools/builtin/http-request.tool.js";
import { sysExecTool } from "../src/tools/builtin/sys-exec.tool.js";

describe("builtin tools self-test", () => {
  it("calc.evaluate exposes dot name and underscore wireName", () => {
    expect(calcEvaluateTool.name).toBe("calc.evaluate");
    expect(calcEvaluateTool.wireName).toBe("calc_evaluate");
  });

  it("json.format exposes dot name and underscore wireName", () => {
    expect(jsonFormatTool.name).toBe("json.format");
    expect(jsonFormatTool.wireName).toBe("json_format");
  });

  it("uuid.generate exposes dot name and underscore wireName", () => {
    expect(uuidGenerateTool.name).toBe("uuid.generate");
    expect(uuidGenerateTool.wireName).toBe("uuid_generate");
  });

  it("time.now exposes dot name and underscore wireName", () => {
    expect(timeNowTool.name).toBe("time.now");
    expect(timeNowTool.wireName).toBe("time_now");
  });

  it("text.diff exposes dot name and underscore wireName", () => {
    expect(textDiffTool.name).toBe("text.diff");
    expect(textDiffTool.wireName).toBe("text_diff");
  });

  it("fs.read exposes dot name and underscore wireName", () => {
    expect(fsReadTool.name).toBe("fs.read");
    expect(fsReadTool.wireName).toBe("fs_read");
  });

  it("fs.write exposes dot name and underscore wireName", () => {
    expect(fsWriteTool.name).toBe("fs.write");
    expect(fsWriteTool.wireName).toBe("fs_write");
  });

  it("fs.list exposes dot name and underscore wireName", () => {
    expect(fsListTool.name).toBe("fs.list");
    expect(fsListTool.wireName).toBe("fs_list");
  });

  it("http.request exposes dot name and underscore wireName", () => {
    expect(httpRequestTool.name).toBe("http.request");
    expect(httpRequestTool.wireName).toBe("http_request");
  });

  it("sys.exec exposes dot name and underscore wireName", () => {
    expect(sysExecTool.name).toBe("sys.exec");
    expect(sysExecTool.wireName).toBe("sys_exec");
  });
});
