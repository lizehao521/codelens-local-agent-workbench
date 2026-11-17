/**
 * bank_ledger：按操作序列驱动一份「整数分」记账台账。跨两个文件协作：
 *   impl.cjs         —— runLedger(ops)：校验操作字段，按顺序喂给台账
 *   lib/ledger.cjs   —— Ledger 类：余额、幂等流水、按日汇总、结息
 *
 * 规范见入口 impl.cjs 头部注释（完整版见 lib/ledger.cjs）。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
const { Ledger, DATE_RE, isNonEmptyString } = require('./lib/ledger.cjs');

function runLedger(ops) {
  const ledger = new Ledger();
  const seen = new Set();

  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = raw && typeof raw === 'object' ? raw : {};

    if (op.op === 'settle') {
      ledger.settle(op);
      continue;
    }
    if (op.op !== 'deposit' && op.op !== 'withdraw' && op.op !== 'transfer') continue;

    // 校验顺序：流水号 → 日期 → 金额 → 账户
    if (!isNonEmptyString(op.txn)) {
      ledger.reject(op.txn, '流水号非法');
      continue;
    }
    if (seen.has(op.txn)) {
      ledger.reject(op.txn, '重复流水号');
      continue;
    }
    seen.add(op.txn);

    if (!DATE_RE.test(op.date)) {
      ledger.reject(op.txn, '日期非法');
      continue;
    }
    if (!Number.isInteger(op.amount) || op.amount <= 0) {
      ledger.reject(op.txn, '金额非法');
      continue;
    }
    if (op.op === 'transfer') {
      if (!isNonEmptyString(op.from) || !isNonEmptyString(op.to)) {
        ledger.reject(op.txn, '账户非法');
        continue;
      }
    } else if (!isNonEmptyString(op.account)) {
      ledger.reject(op.txn, '账户非法');
      continue;
    }

    if (op.op === 'deposit') ledger.deposit(op);
    else if (op.op === 'withdraw') ledger.withdraw(op);
    else ledger.transfer(op);
  }

  return ledger.report();
}

module.exports = { runLedger };
