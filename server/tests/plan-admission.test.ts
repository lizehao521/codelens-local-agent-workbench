import { describe, it, expect } from 'vitest'
import {
  evaluatePlanAdmission,
  type AdmissionItem,
  type PlanAdmissionInput,
  type AdmissionReason,
} from '../src/services/plan/plan-admission.js'

const ITEMS: AdmissionItem[] = [
  { id: 'u01', status: 'approved' },
  { id: 'u02', status: 'running' },
]
const WRITE: Partial<PlanAdmissionInput> = { toolName: 'fs_write', operation: 'create' }

function dec(over: Partial<PlanAdmissionInput>): { allowed: boolean; reason: AdmissionReason } {
  return evaluatePlanAdmission({ items: ITEMS, ...WRITE, ...over })
}

describe('evaluatePlanAdmission — 五路径表驱动精确匹配', () => {
  it('admitted：有活跃条目且请求 id 与之匹配 → 放行', () => {
    expect(dec({ activeItemId: 'u01', requestedItemId: 'u01' })).toEqual({ allowed: true, reason: 'admitted' })
  })

  it('no-active-item：无活跃条目 id → 拒绝', () => {
    expect(dec({ activeItemId: null, requestedItemId: 'u01' })).toEqual({ allowed: false, reason: 'no-active-item' })
  })

  it('no-active-item：activeItemId 指向不存在的条目 → 拒绝（防伪造活跃 id）', () => {
    expect(dec({ activeItemId: 'ghost', requestedItemId: 'ghost' })).toEqual({ allowed: false, reason: 'no-active-item' })
  })

  it('item-not-active：有活跃条目但请求未声明 planItemId → 拒绝（不能靠缺省绕过）', () => {
    expect(dec({ activeItemId: 'u01', requestedItemId: null })).toEqual({ allowed: false, reason: 'item-not-active' })
  })

  it('item-unknown：请求 id 与活跃 id 不一致 → 拒绝（防声明别的条目解锁写入）', () => {
    expect(dec({ activeItemId: 'u01', requestedItemId: 'u02' })).toEqual({ allowed: false, reason: 'item-unknown' })
  })

  it('not-a-plan-write：非写类工具直接放行，且不受活跃条目影响', () => {
    expect(evaluatePlanAdmission({ items: ITEMS, toolName: 'fs.read', operation: 'read', activeItemId: null, requestedItemId: null }))
      .toEqual({ allowed: true, reason: 'not-a-plan-write' })
  })

  it('not-a-plan-write：fs_write 的读操作（read/list）放行', () => {
    expect(dec({ operation: 'read', activeItemId: null, requestedItemId: null }))
      .toEqual({ allowed: true, reason: 'not-a-plan-write' })
  })
})

describe('evaluatePlanAdmission — 纯函数性', () => {
  it('确定性：同一输入三次调用结果逐字相同', () => {
    const input: PlanAdmissionInput = { items: ITEMS, ...WRITE, activeItemId: 'u01', requestedItemId: 'u01' }
    expect(evaluatePlanAdmission(input)).toEqual(evaluatePlanAdmission(input))
    expect(evaluatePlanAdmission(input)).toEqual(evaluatePlanAdmission(input))
  })

  it('不修改入参（items 数组保持原样）', () => {
    const before = JSON.stringify(ITEMS)
    dec({ activeItemId: 'u01', requestedItemId: 'u01' })
    expect(JSON.stringify(ITEMS)).toBe(before)
  })
})

describe('evaluatePlanAdmission — 变异体杀伤（判决要求的三个 mutant）', () => {
  // 这三个断言专门杀死判决列出的假绿实现，任一实现退化都会变红。

  it('杀 mutant「总是 allowed=true」：无活跃条目必须被拒', () => {
    const d = dec({ activeItemId: null, requestedItemId: 'u01' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('no-active-item')
  })

  it('杀 mutant「忽略 requestedItemId 与 activeItemId 的匹配」：声明别的条目必须被拒', () => {
    const d = dec({ activeItemId: 'u01', requestedItemId: 'u02' })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('item-unknown')
  })

  it('杀 mutant「忽略 active 标记只看 items 非空」：未声明 planItemId 必须被拒', () => {
    const d = dec({ activeItemId: 'u01', requestedItemId: null })
    expect(d.allowed).toBe(false)
    expect(d.reason).toBe('item-not-active')
  })
})
