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
 * 文件是 CommonJS：必须保持 `module.exports = { ... }`，不要改成 ESM。
 */

function unescapePointer(p) {
  if (p === '') return []; // 空指针指向整个文档
  const raw = p.split('/').slice(1);
  return raw.map((t) => {
    if (t.indexOf('~') !== -1) {
      if (/~(?!0|1)/.test(t)) throw new Error('非法路径转义');
      return t.replace(/~1/g, '/').replace(/~0/g, '~');
    }
    return t;
  });
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) {
      if (!deepEqual(a[k], b[k])) return false;
    }
    return true;
  }
  return false;
}

function getChild(container, token) {
  if (Array.isArray(container)) {
    const idx = Number(token);
    if (!Number.isInteger(idx)) throw new Error('路径不存在');
    return container[idx];
  }
  if (container && typeof container === 'object') {
    if (!Object.prototype.hasOwnProperty.call(container, token)) {
      throw new Error('路径不存在');
    }
    return container[token];
  }
  throw new Error('路径不存在');
}

function applyPatch(doc, ops) {
  let root = JSON.parse(JSON.stringify(doc)); // 深拷贝，不改动入参
  const list = Array.isArray(ops) ? ops : [];
  for (const raw of list) {
    const o = raw && typeof raw === 'object' ? raw : {};
    const tokens = unescapePointer(String(o.path === undefined ? '' : o.path));
    if (tokens.length === 0) {
      // 空指针：replace 整个文档
      if (o.op === 'replace') {
        root = JSON.parse(JSON.stringify(o.value));
        continue;
      }
      throw new Error('不支持的操作');
    }

    // 导航到父容器
    let parent = root;
    for (let k = 0; k < tokens.length - 1; k += 1) {
      parent = getChild(parent, tokens[k]);
    }
    const last = tokens[tokens.length - 1];

    if (o.op === 'add') {
      if (Array.isArray(parent)) {
        if (last === '-') {
          parent.push(o.value);
        } else {
          const idx = Number(last);
          if (!Number.isInteger(idx) || idx < 0 || idx > parent.length) {
            throw new Error('数组下标越界');
          }
          parent.splice(idx, 0, o.value);
        }
      } else {
        parent[last] = o.value;
      }
    } else if (o.op === 'remove') {
      if (Array.isArray(parent)) {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          throw new Error('路径不存在');
        }
        parent.splice(idx, 1);
      } else {
        if (!Object.prototype.hasOwnProperty.call(parent, last)) {
          throw new Error('路径不存在');
        }
        delete parent[last];
      }
    } else if (o.op === 'replace') {
      if (Array.isArray(parent)) {
        const idx = Number(last);
        if (!Number.isInteger(idx) || idx < 0 || idx >= parent.length) {
          throw new Error('路径不存在');
        }
        parent[idx] = o.value;
      } else {
        if (!Object.prototype.hasOwnProperty.call(parent, last)) {
          throw new Error('路径不存在');
        }
        parent[last] = o.value;
      }
    } else if (o.op === 'test') {
      const current = Array.isArray(parent)
        ? parent[Number(last)]
        : parent[last];
      if (!deepEqual(current, o.value)) {
        throw new Error('test 校验失败');
      }
    } else {
      throw new Error('不支持的操作');
    }
  }
  return root;
}

module.exports = { applyPatch };
