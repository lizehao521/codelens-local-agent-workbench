import { describe, it, expect, beforeEach } from 'vitest'
import { createDb, type Db } from '../src/repositories/db.js'
import { SCHEMA_SQL } from '../src/repositories/schema.js'
import { PlanRepository } from '../src/repositories/plan.repository.js'
import { PlanService, PlanInvalidTransitionError } from '../src/services/plan/plan.service.js'

describe('PlanService', () => {
  let db: Db
  let svc: PlanService

  beforeEach(() => {
    db = createDb(':memory:')
    db.exec(SCHEMA_SQL)
    svc = new PlanService(new PlanRepository(db))
    const now = Date.now()
    db.run(
      "INSERT INTO sessions (id,title,provider,model,created_at,updated_at) VALUES (?,?,?,?,?,?)",
      ['s1', 't', 'p', 'm', now, now]
    )
  })

  it('create → get：初始 status 为 draft，steps 与 sessionId 正确', () => {
    const steps = [{ title: 'Step 1' }, { title: 'Step 2' }]
    const plan = svc.create('s1', { title: 'Plan A', steps })
    const got = svc.get(plan.id)
    expect(got).toBeDefined()
    expect(got!.status).toBe('draft')
    expect(got!.steps).toEqual(steps)
    expect(got!.sessionId).toBe('s1')
  })

  it('listBySession：建 2 个计划返回 2 条，按 created_at 倒序', () => {
    const p1 = svc.create('s1', { title: 'P1', steps: [] })
    const p2 = svc.create('s1', { title: 'P2', steps: [] })
    db.run('UPDATE agent_plans SET created_at = ? WHERE id = ?', [1000, p1.id])
    db.run('UPDATE agent_plans SET created_at = ? WHERE id = ?', [2000, p2.id])
    const list = svc.listBySession('s1', 50)
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe(p2.id)
    expect(list[1].id).toBe(p1.id)
  })

  it('replace：改 steps 与 title 后 get 反映新值；不存在 id 返回 undefined', () => {
    const p = svc.create('s1', { title: 'Old', steps: [{ title: 'a' }] })
    const newSteps = [{ title: 'b' }, { title: 'c' }]
    svc.replace(p.id, { title: 'New', steps: newSteps })
    const got = svc.get(p.id)
    expect(got!.title).toBe('New')
    expect(got!.steps).toEqual(newSteps)
    expect(svc.replace('no-such-id', { title: 'x', steps: [] })).toBeUndefined()
  })

  it('transition 合法链：draft→approved→running→done，每步 status 更新', () => {
    const p = svc.create('s1', { title: 'T', steps: [] })
    expect(svc.transition(p.id, 'approved')!.status).toBe('approved')
    expect(svc.transition(p.id, 'running')!.status).toBe('running')
    expect(svc.transition(p.id, 'done')!.status).toBe('done')
    expect(svc.get(p.id)!.status).toBe('done')
  })

  it('transition 非法：done→approved 抛 PlanInvalidTransitionError', () => {
    const p = svc.create('s1', { title: 'T', steps: [] })
    svc.transition(p.id, 'approved')
    svc.transition(p.id, 'running')
    svc.transition(p.id, 'done')
    expect(() => svc.transition(p.id, 'approved')).toThrow(PlanInvalidTransitionError)
  })

  it('steps_json 损坏兜底：直接改坏 steps_json 后 get 返回 steps=[]', () => {
    const p = svc.create('s1', { title: 'T', steps: [{ title: 'a' }] })
    db.run('UPDATE agent_plans SET steps_json = ? WHERE id = ?', ['not json', p.id])
    const got = svc.get(p.id)
    expect(got).toBeDefined()
    expect(got!.steps).toEqual([])
  })
})
