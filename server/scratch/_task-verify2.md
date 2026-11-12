# 任务：跑一个测试文件，报告结果

只做一件事，别做别的。

## 直接执行（不要先读文件，不要列目录）

调 `test.run`，参数就这两个：

```json
{
  "file": "tests/contract/rsi-exit-consistency.test.ts",
  "root": "C:/Users/Admin/Desktop/新建文件夹 (2)/server"
}
```

`root` 必须原样传这个绝对路径。仓库不在沙箱里，不传 root 工具会去沙箱根找一个不存在的项目（那正是之前的坑）。

## 如果它失败

按错误码处理，**不要自己发挥**：

- `VITEST_MISSING` → 说明 root 传错了，把 root 改成上面的值重试一次。
- `NOT_FOUND` → 文件路径写错了，照抄上面的 `file`。
- `TOOL_SECURITY_DENIED` → 把报错原文贴出来，停止，不要换路径试。
- `TEST_FAILED` → 把 `data.failures` 里每条的 `name` 和 `message` 原样贴出来。

## 报告格式（三行以内）

1. 第一次调用的结果：ok / 错误码
2. 若失败：错误原文（截断到 300 字）
3. 若成功：`data.total` / `data.passed` 两个数字

禁止调用 fs.write。禁止修改任何文件。禁止读 client/ 下的任何内容。
