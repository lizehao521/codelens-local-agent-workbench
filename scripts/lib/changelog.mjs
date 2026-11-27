/**
 * CHANGELOG 生成核心 —— 纯函数，不碰文件系统、不调 git。
 *
 * 为什么把逻辑拆出来：CLI 的行为依赖仓库当天的提交历史，没法在用例里复现；
 * 但「哪些提交该进日志、进到哪一节、以什么顺序排、合并时怎么去重」这些决定
 * 必须能被回归钉住。所以：解析/分组/渲染/合并在本文件，git 调用在
 * scripts/gen-changelog.mjs。
 *
 * 约定（与仓库既有 CHANGELOG 一致，Keep a Changelog 中文版）：
 *  - 最新版本在最上面，未发布内容固定挂在 `## [Unreleased]`；
 *  - 分组标题用中文，顺序由 GROUP_ORDER 决定，不跟 commit 出现顺序走；
 *  - 合并提交（`Merge ...`）与发版提交（`chore(release): ...`）不产生条目。
 */

export const GROUP_ORDER = ['新增', '修复', '变更', '性能', '文档', '重构', '测试', '杂项'];

const TYPE_GROUP = {
  feat: '新增',
  fix: '修复',
  perf: '性能',
  docs: '文档',
  refactor: '重构',
  test: '测试',
  chore: '杂项',
  build: '杂项',
  ci: '杂项',
  style: '杂项',
  revert: '修复',
};

const VERSION_HEADING = /^##\s+\[(\d+\.\d+\.\d+|Unreleased)\]/;

/**
 * 解析一条提交标题（`feat(scope)!: 描述`）。
 * 解析不了的标题不丢弃 —— 落进「杂项」，否则手写的中文提交会整条消失。
 */
export function parseCommitSubject(subject) {
  const line = String(subject ?? '').trim();
  if (!line) return null;
  if (/^Merge\b/i.test(line)) return null;
  const m = /^([a-zA-Z]+)(?:\(([^)]*)\))?(!)?\s*[:：]\s*(.+)$/.exec(line);
  if (!m) {
    return { type: 'other', group: '杂项', scope: null, text: line, breaking: false };
  }
  const [, type, scope, bang, text] = m;
  const lower = type.toLowerCase();
  const cleanScope = scope ? scope.trim() : null;
  // 发版提交只是把上一段 Unreleased 改名，写进日志是自我指涉。
  if (lower === 'chore' && cleanScope === 'release') return null;
  return {
    type: lower,
    group: TYPE_GROUP[lower] ?? '杂项',
    scope: cleanScope,
    text: text.trim(),
    breaking: Boolean(bang),
  };
}

/** 按 GROUP_ORDER 分组；返回的 groups 已排序，空组不出现。 */
export function groupCommits(commits) {
  const buckets = new Map();
  const skipped = [];
  for (const commit of commits ?? []) {
    const parsed = parseCommitSubject(commit?.subject);
    if (!parsed) {
      skipped.push(commit);
      continue;
    }
    const list = buckets.get(parsed.group) ?? [];
    list.push({ hash: commit.hash ?? '', ...parsed });
    buckets.set(parsed.group, list);
  }
  const groups = GROUP_ORDER.filter((title) => buckets.has(title)).map((title) => ({
    title,
    entries: buckets.get(title),
  }));
  return { groups, skipped };
}

/** 单条条目 → `- 描述（scope）`；破坏性变更额外前置标记。 */
export function renderEntry(entry) {
  const scope = entry.scope ? `（${entry.scope}）` : '';
  const breaking = entry.breaking ? '**破坏性变更** ' : '';
  return `- ${breaking}${entry.text}${scope}`;
}

/** 分组 → `### 新增\n- ...` 段落；空分组整体省略。 */
export function renderGroups(groups) {
  const blocks = [];
  for (const group of groups ?? []) {
    const entries = group.entries ?? [];
    if (entries.length === 0) continue;
    blocks.push(`### ${group.title}\n\n${entries.map(renderEntry).join('\n')}`);
  }
  return blocks.join('\n\n');
}

/**
 * 把一段正文并进 `## [Unreleased]`：有该段就追加去重，没有就新建在首个版本段之前。
 * 去重按 `- ` 之后的正文比对 —— 同一个提交被跑两次是常态（幂等要求）。
 */
export function mergeUnreleased(text, body) {
  const source = String(text ?? '');
  const incoming = String(body ?? '').trim();
  const span = findSection(source, 'Unreleased');

  if (!span) {
    const block = `## [Unreleased]\n\n${incoming}`;
    const firstVersion = source.split('\n').findIndex((line) => VERSION_HEADING.test(line));
    if (firstVersion === -1) return `${source.trimEnd()}\n\n${block}\n`;
    const lines = source.split('\n');
    const head = lines.slice(0, firstVersion).join('\n').trimEnd();
    const tail = lines.slice(firstVersion).join('\n');
    return `${head}\n\n${block}\n\n${tail}`;
  }

  const existing = source.slice(span.start, span.end);
  const merged = appendMissing(existing, incoming);
  return `${source.slice(0, span.start)}${merged}${source.slice(span.end)}`;
}

/**
 * 发版切段：把当前 `## [Unreleased]` 改成 `## [version] - date`，
 * 并在它上面新开一个空的 Unreleased。正文原样搬走（已人工润色过的不重写）。
 */
export function freezeRelease(text, version, date) {
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ''))) {
    throw new Error(`版本号必须是 x.y.z：${version}`);
  }
  const source = String(text ?? '');
  if (new RegExp(`^##\\s+\\[${version.replace(/\./g, '\\.')}\\]`, 'm').test(source)) {
    throw new Error(`CHANGELOG 里已经有 [${version}] 了`);
  }
  const span = findSection(source, 'Unreleased');
  if (!span) throw new Error('CHANGELOG 里没有 [Unreleased] 段，无从切版');

  const body = source.slice(span.headingEnd, span.end).replace(/^\n+/, '').trimEnd();
  const frozen = `## [${version}] - ${date}\n\n${body}`;
  const fresh = `## [Unreleased]\n\n${frozen}`;
  // 段尾的换行原本属于被替掉的区间（span.end 正好指向下一个 `## [`），必须补回来，
  // 否则新版本标题会粘在上一行末尾 —— 这一条被 tests/self-upgrade/changelog-gen 钉住。
  return `${source.slice(0, span.start)}${fresh}\n${source.slice(span.end)}`;
}

/** CHANGELOG 里最新的已发布版本号；没有则 null。 */
export function parseLatestVersion(text) {
  const match = String(text ?? '').match(/^##\s+\[(\d+\.\d+\.\d+)\]/m);
  return match ? match[1] : null;
}

/** 定位某个 `## [name]` 段的 [start, headingEnd, end)。 */
function findSection(text, name) {
  const lines = String(text ?? '').split('\n');
  let start = -1;
  let headingEnd = -1;
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const isTarget = start === -1 && line.trim() === `## [${name}]`;
    if (start === -1 && VERSION_HEADING.test(line)) {
      if (!isTarget) continue;
      start = offset;
      headingEnd = offset + line.length;
    } else if (start !== -1 && VERSION_HEADING.test(line)) {
      return { start, headingEnd, end: offset };
    }
    offset += line.length + 1;
  }
  if (start === -1) return null;
  return { start, headingEnd, end: Math.min(offset, text.length) };
}

/** 把新正文按小节并进已有正文，已存在的条目跳过（同文本即视为重复）。 */
function appendMissing(existing, incoming) {
  const seen = new Set(
    existing
      .split('\n')
      .filter((line) => line.startsWith('- '))
      .map((line) => normalizeBullet(line)),
  );
  const kept = [];
  for (const line of incoming.split('\n')) {
    if (!line.startsWith('- ')) {
      kept.push(line);
      continue;
    }
    const key = normalizeBullet(line);
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop();
  const addition = kept.join('\n').trim();
  if (!addition) return existing;
  // 已有内容以空行结尾时直接拼，否则补一个空行分隔。
  const base = existing.replace(/\s+$/, '');
  return `${base}\n\n${addition}\n\n`;
}

function normalizeBullet(line) {
  return line.replace(/^-\s+/, '').replace(/\s+/g, ' ').trim();
}