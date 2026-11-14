/**
 * bank_ledger：按操作序列驱动一份「整数分」记账台账。跨两个文件协作：
 *   impl.cjs         —— runLedger(ops)：校验操作字段，按顺序喂给台账
 *   lib/ledger.cjs   —— Ledger 类：余额、幂等流水、按日汇总、结息
 *
 * 规范：
 *   1) 金额一律是**整数分**（Number.isInteger 且 > 0）。非整数、0、负数、
 *      字符串数字都算非法 → 拒绝，reason「金额非法」。
 *   2) 交易类操作（deposit / withdraw / transfer）必须先校验：
 *      流水号 txn 是非空字符串 → 否则「流水号非法」；
 *      日期 date 匹配 /^\d{4}-\d{2}-\d{2}$/ → 否则「日期非法」；
 *      account（transfer 为 from / to）是非空字符串 → 否则「账户非法」。
 *      校验顺序：流水号 → 日期 → 金额 → 账户。
 *   3) 幂等：同一 txn 只会被处理一次。**被拒绝的交易同样消耗流水号**，
 *      再次出现判「重复流水号」；流水号校验失败（非法 txn）不消耗。
 *   4) withdraw / transfer 余额不足 → 整笔拒绝「余额不足」，双方余额都不变；
 *      transfer 的 from 与 to 相同 → 「转出转入相同」。
 *   5) settle { date, rateBps }：date 非法 →「日期非法」；同一 date 只能结息一次，
 *      重复 →「重复结息」；rateBps 必须是 0..10000 的整数 → 否则「利率非法」。
 *      结息只作用于余额 > 0 的账户：利息 = Math.floor(balance * rateBps / 10000)，
 *      利息为 0 不产生记账。结息不是外部流水，不进入 applied。
 *   6) 按日汇总 days：只收录当日发生过记账（含利息）的日期，日期升序；
 *      每项 { date, net, count, interest }：net 是当日所有记账的带符号净额
 *      （转账双边抵销为 0），count 是当日被接受的交易类操作笔数，interest 是
 *      当日结息入账的利息总额。
 *   7) 返回 { balances, applied, rejected, days }：
 *      balances 为账户余额（键为账户 id），applied 为被接受的 txn（按处理顺序），
 *      rejected 为 { txn, reason }（非交易类错误 txn 记为 ''）。
 *
 * 当前实现有真实缺陷（分布在字段校验、幂等、转账、结息、按日汇总里）——
 * 这是真实缺陷，不是注释错误。两个文件都是 CommonJS：
 * 必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
const { Ledger } = require('./lib/ledger.cjs');

function runLedger(ops) {
  const ledger = new Ledger();
  for (const raw of Array.isArray(ops) ? ops : []) {
    const op = raw && typeof raw === 'object' ? raw : {};
    if (op.op === 'settle') {
      ledger.settle(op);
      continue;
    }
    if (op.op !== 'deposit' && op.op !== 'withdraw' && op.op !== 'transfer') continue;
    if (!op.txn) {
      ledger.reject(op.txn, '流水号非法');
      continue;
    }
    if (typeof op.date !== 'string') {
      ledger.reject(op.txn, '日期非法');
      continue;
    }
    if (typeof op.amount !== 'number' || !Number.isFinite(op.amount) || op.amount <= 0) {
      ledger.reject(op.txn, '金额非法');
      continue;
    }
    if (op.op === 'deposit') ledger.deposit(op);
    else if (op.op === 'withdraw') ledger.withdraw(op);
    else ledger.transfer(op);
  }
  return ledger.report();
}

module.exports = { runLedger };
