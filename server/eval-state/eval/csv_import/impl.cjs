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
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */
function parseCsv(input) {
  const text = String(input)
    .replace(/^\uFEFF/, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');
  const rows = [];
  const errors = [];
  const n = text.length;
  let i = 0;
  let line = 1; // 下一个待消费字符所在的物理行号（从 1 开始）
  let expected; // 第一条成功记录的列数

  const closeRecord = (fields, startLine, recErr) => {
    if (recErr) {
      errors.push(recErr);
      return;
    }
    if (expected === undefined) expected = fields.length;
    if (fields.length !== expected) {
      errors.push({
        line: startLine,
        message: `列数不一致（期望 ${expected}，实际 ${fields.length}）`,
      });
      return;
    }
    rows.push(fields);
  };

  while (i < n) {
    // —— 记录边界：跳过空行 / 纯空白行（不计行、不算错误）——
    let j = i;
    while (j < n && text[j] !== '\n') j++;
    if (text.slice(i, j).trim() === '') {
      i = j + 1;
      line += 1;
      continue;
    }

    // —— 解析一条记录 ——
    let recordStartLine = line;
    let fields = [];
    let field = '';
    let inQuotes = false;
    let fieldQuoted = false;
    let startedField = false;
    let quoteJustClosed = false;
    let recordError = null;

    while (i < n) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') {
            field += '"';
            i += 2;
            continue;
          }
          inQuotes = false;
          quoteJustClosed = true;
          i += 1;
          continue;
        }
        if (c === '\n') line += 1;
        field += c;
        i += 1;
        continue;
      }

      // 不在引号内
      if (c === '"') {
        if (!startedField) {
          startedField = true;
          recordStartLine = line;
        }
        inQuotes = true;
        fieldQuoted = true;
        i += 1;
        continue;
      }
      if (c === ',') {
        if (!startedField) {
          startedField = true;
          recordStartLine = line;
        }
        fields.push(fieldQuoted ? field : field.trim());
        field = '';
        fieldQuoted = false;
        quoteJustClosed = false;
        i += 1;
        continue;
      }
      if (c === '\n') {
        i += 1;
        line += 1;
        if (startedField) {
          fields.push(fieldQuoted ? field : field.trim());
          closeRecord(fields, recordStartLine, recordError);
          startedField = false;
        }
        break; // 回到外层处理边界（含空行跳过）
      }
      // 普通字符（含未引用字段内的空白）
      if (!startedField) {
        startedField = true;
        recordStartLine = line;
      }
      if (quoteJustClosed) {
        // 闭合引号后紧跟的非分隔符字符 → 「引号闭合后出现多余字符」
        if (!recordError) {
          recordError = { line: recordStartLine, message: '引号闭合后出现多余字符' };
        }
        quoteJustClosed = false;
      }
      field += c;
      i += 1;
    }

    if (startedField) {
      // 文件结束仍未遇到换行：收尾当前记录
      if (inQuotes) {
        errors.push({ line: recordStartLine, message: '引号未闭合' });
      } else {
        fields.push(fieldQuoted ? field : field.trim());
        closeRecord(fields, recordStartLine, recordError);
      }
    }
  }

  return { rows, errors };
}

module.exports = { parseCsv };
