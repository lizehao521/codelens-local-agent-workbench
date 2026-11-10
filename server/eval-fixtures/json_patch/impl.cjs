/**
 * json_patch：把一组 JSON Patch 操作（RFC 6902 子集）应用到文档上，返回新文档。
 * 路径是 RFC 6901 JSON Pointer。规范：
 *
 *   1) 指针以 '/' 开头，逐段解码：`~1` 还原成 '/'，`~0` 还原成 '~'；
 *      `~` 后面不是 0 或 1 属于非法转义 → 抛 Error('非法路径转义')。
 *      空字符串指针 '' 指向整个文档。
 *   2) 中间路径必须已存在：走到不存在的键/下标 → 抛 Error('路径不存在')。
 *   3) add：
 *      - 父容器是对象 → 直接设置该键（可新增）；
 *      - 父容器是数组 → 在该下标**之前**插入（后面的元素后移）；
 *        路径末段是 '-' 表示追加到末尾；下标超过数组长度 → 抛 Error('数组下标越界')。
 *   4) remove：目标必须存在，否则抛 Error('路径不存在')；数组元素删掉后其余前移。
 *   5) replace：目标必须**已存在**，否则抛 Error('路径不存在')。
 *   6) test：文档当前值与 value 深比较，不一致抛 Error('test 校验失败')。
 *   7) 其它 op → 抛 Error('不支持的操作')。
 *   8) 依次执行全部操作，输入文档不能被就地修改（返回的是新文档）。
 *
 * 当前实现是「按 '/' 直接拆分、不处理转义、不做存在性校验」的天真版本 ——
 * 这是真实缺陷，不是注释错误。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function applyPatch(doc, ops) {
  const out = JSON.parse(JSON.stringify(doc));
  for (const op of Array.isArray(ops) ? ops : []) {
    const tokens = String(op.path).split('/').slice(1);
    const last = tokens.pop();
    let parent = out;
    for (const token of tokens) parent = parent[token];
    if (op.op === 'add') {
      if (Array.isArray(parent)) parent.splice(Number(last) + 1, 0, op.value);
      else parent[last] = op.value;
    } else if (op.op === 'remove') {
      if (Array.isArray(parent)) parent.splice(Number(last), 1);
      else delete parent[last];
    } else if (op.op === 'replace') {
      parent[last] = op.value;
    } else if (op.op === 'test') {
      /* 不校验：只要调用方说 test 就当作通过 */
    } else {
      parent[last] = op.value;
    }
  }
  return out;
}
module.exports = { applyPatch };
