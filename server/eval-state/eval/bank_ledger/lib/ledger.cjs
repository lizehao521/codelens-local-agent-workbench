/**
 * 整数分台账。规范见入口 impl.cjs 头部注释。
 *
 * 当前实现有真实缺陷：
 *   - 幂等只比对「已入账」列表，被拒绝的交易重放时会被再次处理；
 *   - 转账不拦同账户，且按日汇总只记了转出侧，净额少一笔转入；
 *   - 结息用 Math.round 而不是向下取整，且不记录已结息日期；
 *   - days 按插入顺序返回，没有按日期升序。
 * 这些缺陷都要跨多笔操作、或跨到结算日才能暴露。
 */
class Ledger {
  constructor() {
    this.balances = new Map();
    this.applied = [];
    this.rejected = [];
    this.days = new Map();
  }

  reject(txn, reason) {
    this.rejected.push({ txn: typeof txn === 'string' ? txn : '', reason });
  }

  balanceOf(account) {
    return this.balances.get(account) || 0;
  }

  add(account, delta) {
    this.balances.set(account, this.balanceOf(account) + delta);
  }

  day(date) {
    let entry = this.days.get(date);
    if (!entry) {
      entry = { date, net: 0, count: 0, interest: 0 };
      this.days.set(date, entry);
    }
    return entry;
  }

  deposit(op) {
    if (this.applied.indexOf(op.txn) !== -1) {
      this.reject(op.txn, '重复流水号');
      return;
    }
    this.add(op.account, op.amount);
    const entry = this.day(op.date);
    entry.net += op.amount;
    entry.count += 1;
    this.applied.push(op.txn);
  }

  withdraw(op) {
    if (this.applied.indexOf(op.txn) !== -1) {
      this.reject(op.txn, '重复流水号');
      return;
    }
    if (this.balanceOf(op.account) < op.amount) {
      this.reject(op.txn, '余额不足');
      return;
    }
    this.add(op.account, -op.amount);
    const entry = this.day(op.date);
    entry.net -= op.amount;
    entry.count += 1;
    this.applied.push(op.txn);
  }

  transfer(op) {
    if (this.applied.indexOf(op.txn) !== -1) {
      this.reject(op.txn, '重复流水号');
      return;
    }
    if (this.balanceOf(op.from) < op.amount) {
      this.reject(op.txn, '余额不足');
      return;
    }
    this.add(op.from, -op.amount);
    this.add(op.to, op.amount);
    const entry = this.day(op.date);
    entry.net -= op.amount;
    entry.count += 1;
    this.applied.push(op.txn);
  }

  settle(op) {
    if (typeof op.rateBps !== 'number' || op.rateBps < 0) {
      this.reject('', '利率非法');
      return;
    }
    for (const account of this.balances.keys()) {
      const balance = this.balanceOf(account);
      if (balance <= 0) continue;
      const interest = Math.round((balance * op.rateBps) / 10000);
      if (interest <= 0) continue;
      this.add(account, interest);
      const entry = this.day(op.date);
      entry.net += interest;
      entry.interest += interest;
    }
  }

  report() {
    const balances = {};
    for (const [account, amount] of this.balances) balances[account] = amount;
    return {
      balances,
      applied: this.applied.slice(),
      rejected: this.rejected.slice(),
      days: [...this.days.values()],
    };
  }
}

module.exports = { Ledger };
