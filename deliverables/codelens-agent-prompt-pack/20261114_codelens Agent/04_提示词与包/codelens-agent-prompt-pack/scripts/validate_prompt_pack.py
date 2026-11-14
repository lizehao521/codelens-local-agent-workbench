#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""CodeLens 专家级提示词包 · 自检脚本。

用法：
    python validate_prompt_pack.py --help
    python validate_prompt_pack.py                     # 默认包根 = 本脚本所在目录的上一级
    python validate_prompt_pack.py --root <包根路径>
    python validate_prompt_pack.py --self-test         # 用临时夹具验证 7 项检查逻辑

检查项：
    (1) 16 份提示词文件齐全
    (2) 每份 7 个字段标题齐全
    (3) 每份有元信息头、槽位 ID 唯一且不重复
    (4) SKILL.md frontmatter 8 必填字段齐全且可解析
    (5) @references/ 引用的文件都真实存在
    (6) 全文无硬编码密钥形态
    (7) 活读数不得写成规范（命中告警 WARN，不计入失败）

输出逐项 PASS/FAIL/WARN + 总计；FAIL>0 时 exit 1，否则 exit 0。
脚本本身不含任何真实密钥；示例凭据一律 ${VAR} 占位。
"""

from __future__ import annotations

import argparse
import re
import sys
import tempfile
from pathlib import Path

# ---- 固定清单（与 README 索引表一致；主编按此文件名落盘） ----
PROMPT_FILES = [
    "A01-requirement-clarification.md",
    "A02-solution-design.md",
    "A03-implementation.md",
    "A04-code-review.md",
    "A05-test-acceptance.md",
    "A06-debugging.md",
    "A07-refactoring.md",
    "B01-task-spec.md",
    "B02-act-execution.md",
    "B03-judge-authoring.md",
    "B04-verification-attribution.md",
    "B05-adoption-governance.md",
    "B06-tool-contract.md",
    "B07-runtime-diagnosis.md",
    "S00-router.md",
    "S01-handoff.md",
]

FIELD_TITLES = ["角色定位", "任务目标", "上下文输入", "约束条件",
                "输出格式", "边界情况", "质量要求"]

REQUIRED_FM = ["name", "display_name", "display_name_en", "description",
               "description_zh", "description_en", "version", "author"]

# 只扫描内容文件；脚本自身 (.py) 不在其列，避免检测模式串被自己命中
CONTENT_EXT = {".md", ".markdown", ".txt", ".json", ".yaml", ".yml"}

# 兼容三种元信息头写法：YAML frontmatter `slot: A01`、正文 `- 槽位 ID: A01`、表格 `| 槽位 ID | A01 |`
SLOT_RE = re.compile(
    r"(?m)^[\s\-*>|]*(?:slot|slot_id|槽位\s*ID|Slot\s*ID)"
    r"\s*\*{0,2}\s*[:：|]\s*([A-Za-z0-9][A-Za-z0-9\-]*)"
)
REF_RE = re.compile(r"@references/([A-Za-z0-9_.\-/]+\.md)")
PLACEHOLDER_RE = re.compile(r"\$\{[^}]*\}")
URL_RE = re.compile(r"https?://\S+")
SK_RE = re.compile(r"(?<![A-Za-z0-9])sk-[A-Za-z0-9]{16,}")
OPAQUE_RE = re.compile(
    r"(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])"
    r"|(?<![A-Za-z0-9])[A-Za-z0-9]{40,}(?![A-Za-z0-9])"
)
KV_RE = re.compile(
    r"(?i)(?:api[_-]?key|secret|passwd|password|token)\s*[:=]\s*[\"']?[A-Za-z0-9_\-./+]{6,}"
)
# (7-a) 绝对化断言：必须是 19 个工具 / 规定为 25 题 …
LIVE_ASSERT_RE = re.compile(
    r"(?:必须是|必须|一律是|强制为|规定为|写死为|固定为|恒为|规范要求是|规范是)"
    r"[^。；\n]{0,12}\d+\s*(?:个)?(?:工具|题|用例|文件|张表|passed|表)"
)
# (7-b) 把活读数写成硬约束：工具只取手册的 19 个内置工具 …
LIVE_HARD_RE = re.compile(
    r"(?:只取|只写|限定为|固定为|写死|一律取|必须取|一律按)"
    r"[^。；\n]{0,20}\d+\s*个\s*(?:内置)?工具"
)
# 明确声明「以实跑为准 / 不写绝对值」的陈述句不算写成规范，豁免
LIVE_EXEMPT_RE = re.compile(r"以实跑为准|不得写成规范|不写绝对值|待核实|互不相容|UNEXEC")

PASS, FAIL, WARN = "PASS", "FAIL", "WARN"


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError):
        try:
            return path.read_text(encoding="utf-8-sig")
        except Exception:
            return ""


def content_files(root: Path):
    return [p for p in sorted(root.rglob("*"))
            if p.is_file() and p.suffix.lower() in CONTENT_EXT]


def parse_frontmatter(text: str):
    """返回 (data|None, 解析方式, 错误|None)。优先 PyYAML，缺失时内置轻量解析。"""
    m = re.match(r"\A\ufeff?\s*---[ \t]*\r?\n(.*?)\r?\n---[ \t]*(?:\r?\n|\Z)",
                 text, re.S)
    if not m:
        return None, "", "未找到被 --- 包裹的 frontmatter"
    block = m.group(1)
    try:
        import yaml  # type: ignore
        data = yaml.safe_load(block)
        if not isinstance(data, dict):
            return None, "PyYAML", "frontmatter 解析结果不是字典"
        return data, "PyYAML", None
    except ImportError:
        pass
    except Exception as exc:
        return None, "PyYAML", "yaml.safe_load 失败: %s" % exc
    # 无 PyYAML：本包 frontmatter 为单行标量，逐行解析等价可验证
    data = {}
    for line in block.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        mm = re.match(r"^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$", line)
        if not mm:
            return None, "内置轻量解析", "无法解析行: %s" % line.strip()
        key, val = mm.group(1), mm.group(2).strip()
        if len(val) >= 2 and val[0] == val[-1] and val[0] in ("\"", "'"):
            val = val[1:-1]
        data[key] = val
    return data, "内置轻量解析", None


def check_1(root: Path):
    missing = [f for f in PROMPT_FILES if not (root / "prompts" / f).is_file()]
    if missing:
        return ("(1)", "16 份提示词齐全", FAIL,
                ["缺失 %d 份：" % len(missing)] + ["  prompts/" + f for f in missing])
    return ("(1)", "16 份提示词齐全", PASS, ["16/16 齐全"])


def check_2(root: Path):
    problems, checked = [], 0
    for f in PROMPT_FILES:
        p = root / "prompts" / f
        if not p.is_file():
            continue
        checked += 1
        lines = [ln.strip() for ln in read_text(p).splitlines()]
        title_lines = [ln for ln in lines
                       if ln.startswith("#") or (ln.startswith("**") and ln.endswith("**"))]
        miss = [fld for fld in FIELD_TITLES
                if not any(fld in ln for ln in title_lines)]
        if miss:
            problems.append("prompts/%s 缺字段标题：%s" % (f, "、".join(miss)))
    if problems:
        return ("(2)", "每份 7 字段标题齐全", FAIL, problems)
    if checked == 0:
        return ("(2)", "每份 7 字段标题齐全", FAIL, ["无可检查的提示词文件（见 (1)）"])
    return ("(2)", "每份 7 字段标题齐全", PASS, ["%d 份 × 7 字段零缺失" % checked])


def check_3(root: Path):
    seen, problems = {}, []
    for f in PROMPT_FILES:
        p = root / "prompts" / f
        if not p.is_file():
            continue
        m = SLOT_RE.search(read_text(p))
        if not m:
            problems.append("prompts/%s 无元信息头（缺 槽位 ID: 或 frontmatter slot:）" % f)
            continue
        sid = m.group(1)
        if sid in seen:
            problems.append("槽位 ID 重复：%s（prompts/%s 与 prompts/%s）"
                            % (sid, seen[sid], f))
        else:
            seen[sid] = f
    if problems:
        return ("(3)", "元信息头与槽位 ID 唯一", FAIL, problems)
    if not seen:
        return ("(3)", "元信息头与槽位 ID 唯一", FAIL, ["未提取到任何槽位 ID（见 (1)）"])
    return ("(3)", "元信息头与槽位 ID 唯一", PASS,
            ["%d 个槽位 ID 唯一、无重复" % len(seen),
             "兼容 slot: / 槽位 ID: / 表格三种元信息头写法"])


def check_4(root: Path):
    p = root / "SKILL.md"
    if not p.is_file():
        return ("(4)", "frontmatter 8 必填字段", FAIL, ["SKILL.md 不存在"])
    data, mode, err = parse_frontmatter(read_text(p))
    if err:
        return ("(4)", "frontmatter 8 必填字段", FAIL, [err, "解析方式：%s" % mode])
    missing = [k for k in REQUIRED_FM if k not in data or data[k] in (None, "")]
    if missing:
        return ("(4)", "frontmatter 8 必填字段", FAIL,
                ["缺失 / 空值字段：%s" % "、".join(missing), "解析方式：%s" % mode])
    return ("(4)", "frontmatter 8 必填字段", PASS,
            ["8/8 齐全且可解析", "解析方式：%s" % mode])


def check_5(root: Path):
    refs = set()
    for p in content_files(root):
        for m in REF_RE.finditer(read_text(p)):
            refs.add(m.group(1))
    if not refs:
        return ("(5)", "@references/ 引用存在", PASS, ["无引用（无需检查）"])
    missing = []
    for rel in sorted(refs):
        if rel.startswith("/") or ".." in rel.split("/"):
            missing.append("非法引用路径：@references/%s" % rel)
        elif not (root / "references" / rel).is_file():
            missing.append("引用文件不存在：@references/%s" % rel)
    if missing:
        return ("(5)", "@references/ 引用存在", FAIL, missing)
    return ("(5)", "@references/ 引用存在", PASS,
            ["%d 个引用文件全部存在" % len(refs)])


def check_6(root: Path):
    hits = []
    for p in content_files(root):
        for i, line in enumerate(read_text(p).splitlines(), 1):
            clean = URL_RE.sub("", PLACEHOLDER_RE.sub("", line))
            found = None
            if SK_RE.search(clean):
                found = "sk 前缀串"
            elif OPAQUE_RE.search(clean):
                found = "32+ 位不透明串"
            elif KV_RE.search(clean):
                found = "凭据类键值"
            if found:
                snippet = clean.strip()[:24]
                hits.append("%s:%d [%s] %s…"
                            % (p.relative_to(root).as_posix(), i, found, snippet))
    if hits:
        return ("(6)", "全文无硬编码密钥", FAIL, hits)
    return ("(6)", "全文无硬编码密钥", PASS,
            ["未检出密钥形态（已剔除 ${} 占位与 URL）"])


def check_7(root: Path):
    hits = []
    for p in content_files(root):
        for i, line in enumerate(read_text(p).splitlines(), 1):
            if LIVE_EXEMPT_RE.search(line):
                continue
            m = LIVE_ASSERT_RE.search(line) or LIVE_HARD_RE.search(line)
            if m:
                hits.append("%s:%d %s…"
                            % (p.relative_to(root).as_posix(), i, line.strip()[:40]))
    if hits:
        return ("(7)", "活读数不写成规范", WARN,
                ["检出 %d 处疑似把活读数写成规范 / 硬约束的句子：" % len(hits)]
                + ["  " + h for h in hits])
    return ("(7)", "活读数不写成规范", PASS, ["未检出绝对化活读数断言"])


def run_all(root: Path):
    return [check_1(root), check_2(root), check_3(root), check_4(root),
            check_5(root), check_6(root), check_7(root)]


def print_report(results):
    print("=" * 66)
    print("CodeLens 专家级提示词包 · 自检报告")
    print("=" * 66)
    for cid, name, status, details in results:
        print("[%-4s] %s %s" % (status, cid, name))
        for d in details:
            print("         - %s" % d)
    npass = sum(1 for r in results if r[2] == PASS)
    nfail = sum(1 for r in results if r[2] == FAIL)
    nwarn = sum(1 for r in results if r[2] == WARN)
    print("-" * 66)
    print("总计：%d 项检查 | PASS %d / FAIL %d / WARN %d"
          % (len(results), npass, nfail, nwarn))
    print("=" * 66)
    return nfail


def _write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _ideal_package(root: Path):
    _write(root / "SKILL.md",
           "---\n" + "\n".join('%s: "v"' % k for k in REQUIRED_FM)
           + "\n---\n\n# t\n见 @references/01-codelens-runtime-facts.md\n")
    _write(root / "references" / "01-codelens-runtime-facts.md", "占位\n")
    for f in PROMPT_FILES:
        sid = f.split("-")[0]
        body = ("## 元信息\n\n- 槽位 ID: %s\n- 适用口径: A\n- 版本: 1.0.0\n\n" % sid)
        for fld in FIELD_TITLES:
            body += "## %s\n\n内容\n\n" % fld
        _write(root / "prompts" / f, body)


def self_test():
    ok = True
    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "ideal"
        _ideal_package(root)
        res = run_all(root)
        bad = [(r[0], r[2]) for r in res if r[2] != PASS]
        if bad:
            print("[SELF-TEST] 理想包应全 PASS，实际：%s .............. FAIL" % bad)
            ok = False
        else:
            print("[SELF-TEST] 理想包 (1)-(7) 全 PASS ..................... PASS")

    with tempfile.TemporaryDirectory() as td:
        root = Path(td) / "broken"
        _ideal_package(root)
        (root / "prompts" / PROMPT_FILES[-1]).unlink()                       # (1)
        p = root / "prompts" / PROMPT_FILES[0]
        _write(p, read_text(p).replace("## 质量要求", "普通文字 质量要求"))  # (2)
        p = root / "prompts" / PROMPT_FILES[1]
        _write(p, re.sub(r"槽位 ID: \S+", "槽位 ID: A01", read_text(p)))     # (3)
        p = root / "SKILL.md"
        _write(p, read_text(p).replace('author: "v"\n', ""))                # (4)
        (root / "references" / "01-codelens-runtime-facts.md").unlink()      # (5)
        p = root / "prompts" / PROMPT_FILES[2]
        _write(p, read_text(p) + "\n凭据 " + "sk-" + "A" * 20
               + " 与 api_key: abcdefghijkl\n")                               # (6)
        p = root / "prompts" / PROMPT_FILES[3]
        _write(p, read_text(p) + "\n必须是 19 个工具。\n")                    # (7)

        status = {r[0]: r[2] for r in run_all(root)}
        expect_fail = ["(1)", "(2)", "(3)", "(4)", "(5)", "(6)"]
        wrong = [c for c in expect_fail if status.get(c) != FAIL]
        if wrong:
            print("[SELF-TEST] 破坏包 (1)-(6) 应全 FAIL，未检出：%s ..... FAIL" % wrong)
            ok = False
        else:
            print("[SELF-TEST] 破坏包 (1)-(6) 均检出 FAIL ................. PASS")
        if status.get("(7)") == WARN:
            print("[SELF-TEST] 破坏包 (7) 检出 WARN ........................ PASS")
        else:
            print("[SELF-TEST] 破坏包 (7) 应 WARN，实际 %s ............. FAIL"
                  % status.get("(7)"))
            ok = False
    print("-" * 66)
    print("[SELF-TEST] 结论：%s" % ("全部通过" if ok else "存在失败"))
    return 0 if ok else 1


def main(argv=None):
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    ap = argparse.ArgumentParser(
        prog="validate_prompt_pack.py",
        description="CodeLens 专家级提示词包自检（7 项检查，逐项 PASS/FAIL/WARN）。",
        epilog="默认包根 = 本脚本所在目录的上一级；FAIL>0 时 exit 1。",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--root", type=str, default=None,
                    help="包根路径（默认：本脚本所在目录的上一级）")
    ap.add_argument("--self-test", action="store_true",
                    help="用临时夹具验证 7 项检查逻辑，不扫描真实包")
    args = ap.parse_args(argv)

    if args.self_test:
        return self_test()

    root = Path(args.root).resolve() if args.root else Path(__file__).resolve().parent.parent
    if not root.is_dir():
        print("[FAIL] 包根不存在：%s" % root)
        return 1
    print("包根：%s" % root)
    nfail = print_report(run_all(root))
    return 1 if nfail > 0 else 0


if __name__ == "__main__":
    sys.exit(main())
