/** BUILTIN_TOOLS — the single registration point for the ten builtin tools. */

import type { ToolDefinition } from '../../types/tool.js';
import { httpRequestTool } from './http-request.tool.js';
import { fsReadTool } from './fs-read.tool.js';
import { fsWriteTool } from './fs-write.tool.js';
import { fsListTool } from './fs-list.tool.js';
import { calcEvaluateTool } from './calc-evaluate.tool.js';
import { timeNowTool } from './time-now.tool.js';
import { uuidGenerateTool } from './uuid-generate.tool.js';
import { jsonFormatTool } from './json-format.tool.js';
import { textDiffTool } from './text-diff.tool.js';
import { sysExecTool } from './sys-exec.tool.js';

export const BUILTIN_TOOLS: readonly ToolDefinition[] = [
  httpRequestTool,
  fsReadTool,
  fsWriteTool,
  fsListTool,
  calcEvaluateTool,
  timeNowTool,
  uuidGenerateTool,
  jsonFormatTool,
  textDiffTool,
  sysExecTool,
];
