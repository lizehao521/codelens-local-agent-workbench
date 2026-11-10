/**
 * csv_import：把 CSV 原始文本解析成二维表。规范：
 *
 *   1) 开头的 BOM（\uFEFF）要剥掉。
 *   2) 换行支持 \n、\r\n 与单独的 \r；统一按 \n 处理（引号内也一样）。
 *   3) 字段用逗号分隔。字段可以用双引号包裹：
 *      - 引号内允许逗号、换行；
 *      - 连续两个双引号 "" 表示一个字面量双引号。
 *   4) 引号必须出现在字段的第一个字符；闭合引号后只能紧跟逗号、换行或文件结束。
 *   5) 未引用字段两端的空格 / 制表符要 trim；引用字段的内容原样保留。
 *   6) 空行（含纯空白行）跳过，不算行、也不算错误。
 *   7) 列数不一致的行不算行，记一条错误：
 *      { line, message: '列数不一致（期望 N，实际 M）' }；
 *      期望列数取第一条成功解析的记录的列数。
 *   8) 引号未闭合：记 { line, message: '引号未闭合' } 并结束解析；
 *      闭合引号后出现其它字符：记 { line, message: '引号闭合后出现多余字符' }，
 *      该行跳过、后续行继续。
 *   9) line 是记录起始的物理行号（从 1 开始），要计入引号内的换行。
 *
 * 返回 { rows: string[][], errors: [{ line, message }] }。
 *
 * 当前实现是「按行拆分 + 按逗号拆分」的天真版本 —— 这是真实缺陷，不是注释错误。
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseCsv(input) {
  const text = String(input).replace(/^\uFEFF/, '');
  const rows = [];
  const errors = [];
  let expected;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw.trim() === '') continue;
    const fields = raw.split(',').map((f) => f.trim());
    if (expected === undefined) {
      expected = fields.length;
    } else if (fields.length !== expected) {
      errors.push({
        line: i + 1,
        message: `列数不一致（期望 ${expected}，实际 ${fields.length}）`,
      });
      continue;
    }
    rows.push(fields);
  }

  return { rows, errors };
}

module.exports = { parseCsv };
