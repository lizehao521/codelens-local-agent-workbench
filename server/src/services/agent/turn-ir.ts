/**
 * Turn IR: the common output of both channels. The loop consumes TurnIR and never
 * learns which channel produced it (architecture 5.1).
 */

import type { NormalizedToolCall } from '../../types/index.js';
import type { Usage } from '../../types/index.js';

export interface ToolCallIR {
  id: string;
  /** Wire name (native) or model-written name (ReAct) — resolve before use. */
  name: string;
  arguments: Record<string, unknown>;
  rawArguments: string;
  channel: 'native' | 'react';
  parseError?: NormalizedToolCall['parseError'];
}

export interface TurnIR {
  text: string;
  /** Reasoning-chain text (thinking models); streamed separately, stored on the message. */
  reasoning: string;
  toolCalls: ToolCallIR[];
  finishReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error';
  warnings: string[];
  usage: Usage;
}
