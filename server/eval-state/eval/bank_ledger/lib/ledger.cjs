/**
 * 整数分台账。规范见入口 impl.cjs 头部注释。
 *
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isNonEmptyString(x) {
  return typeof x === 'string' && x.length > 0;
}

class Ledger {
  constructor() {
    this.balances = new Map();
    this.applied = [];
    this.rejected = [];
    this.days = new Map();
    this.settledDates = new Set();
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
    this.add(op.account, op.amount);
    const entry = this.day(op.date);
    entry.net += op.amount;
    entry.count += 1;
    this.applied.push(op.txn);
  }

  withdraw(op) {
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
    if (op.from === op.to) {
      this.reject(op.txn, '转出转入相同');
      return;
    }
    if (this.balanceOf(op.from) < op.amount) {
      this.reject(op.txn, '余额不足');
      return;
    }
    this.add(op.from, -op.amount);
    this.add(op.to, op.amount);
    // 转账双边抵销，当日净额为 0，只计笔数
    const entry = this.day(op.date);
    entry.count += 1;
    this.applied.push(op.txn);
  }

  settle(op) {
    if (!DATE_RE.test(op.date)) {
      this.reject('', '日期非法');
      return;
    }
    const r = op.rateBps;
    if (!Number.isInteger(r) || r < 0 || r > 10000) {
      this.reject('', '利率非法');
      return;
    }
    if (this.settledDates.has(op.date)) {
      this.reject('', '重复结息');
      return;
    }
    this.settledDates.add(op.date);
    for (const account of [...this.balances.keys()]) {
      const balance = this.balanceOf(account);
      if (balance <= 0) continue;
      const interest = Math.floor((balance * r) / 10000);
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
    const days = [...this.days.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );
    return {
      balances,
      applied: this.applied.slice(),
      rejected: this.rejected.slice(),
      days,
    };
  }
}

module.exports = { Ledger, DATE_RE, isNonEmptyString };
