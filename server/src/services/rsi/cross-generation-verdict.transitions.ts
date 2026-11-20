/**
 * 判决状态机声明式转移表（fail-closed：refused/不可比优先于一切诊断观察）。
 * 从 cross-generation-verdict.ts 拆出（结构棘轮 ≤300 行）；主模块 re-export。
 */

import type { CrossGenerationVerdict, VerdictStateTransition } from './cross-generation-verdict.types.js';

/**
 * Declarative state table. Evaluation is fail-closed: refusal and missing
 * comparability take precedence over every diagnostic observation.
 */
export const VERDICT_STATE_TRANSITIONS: readonly VerdictStateTransition[] = [
  {
    from: 'initial',
    event: 'multiple_primary_objectives',
    to: 'refused',
    rule: 'Exactly one primary objective is required.',
  },
  {
    from: 'initial',
    event: 'missing_evidence_level',
    to: 'refused',
    rule: 'Both generations must carry a known evidence level.',
  },
  {
    from: 'initial',
    event: 'invalid_evidence_transition',
    to: 'refused',
    rule: 'Evidence may advance only one adjacent level and may never regress.',
  },
  {
    from: 'initial',
    event: 'primary_not_comparable',
    to: 'undecidable',
    rule: 'A missing or changed primary metric definition cannot establish improvement.',
  },
  {
    from: 'initial',
    event: 'primary_not_improved',
    to: 'not_improved',
    rule: 'The primary objective must strictly improve.',
  },
  {
    from: 'initial',
    event: 'guard_regressed',
    to: 'not_improved',
    rule: 'No guard may regress, even when the primary objective improves.',
  },
  {
    from: 'initial',
    event: 'primary_strictly_improved',
    to: 'improved',
    rule: 'Strict primary improvement, valid evidence, and no guard regression are required.',
  },
  {
    from: 'improved',
    event: 'evaluate',
    to: 'improved',
    rule: 'A verdict is terminal for one evaluation; diagnostics cannot change it.',
  },
  {
    from: 'not_improved',
    event: 'evaluate',
    to: 'not_improved',
    rule: 'Auxiliary improvements cannot overturn a failed primary objective or guard.',
  },
  {
    from: 'undecidable',
    event: 'evaluate',
    to: 'undecidable',
    rule: 'Missing comparability cannot be repaired by auxiliary metrics.',
  },
  {
    from: 'refused',
    event: 'evaluate',
    to: 'refused',
    rule: 'Refused inputs are never promoted by later diagnostic evidence.',
  },
] as const;
