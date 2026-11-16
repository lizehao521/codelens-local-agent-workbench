/** exemplars.jsonl 的正例选取与注入：纯逻辑，便于直接判定。 */
import { readFileSync } from 'node:fs';

export interface ExemplarRecord {
  id: string;
  title: string;
  gapType: string;
  targetFile: string;
  observable: string;
  passed: string[];
  at: string;
}

export interface ExemplarBudget {
  /** 0 = 不限。 */
  maxItems: number;
  /** 渲染后字符上限；0 = 不限。首条例外，避免预算过小导致永远空注入。 */
  maxChars: number;
}

export interface ExemplarSelection {
  selected: ExemplarRecord[];
  evicted: ExemplarRecord[];
  chars: number;
  overflow: boolean;
  invalidLines: number;
}

export function parseExemplars(text: string): { records: ExemplarRecord[]; invalidLines: number } {
  const records: ExemplarRecord[] = [];
  let invalidLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as Partial<ExemplarRecord>;
      if (
        typeof raw.id !== 'string' ||
        typeof raw.title !== 'string' ||
        typeof raw.observable !== 'string' ||
        !Array.isArray(raw.passed) ||
        raw.passed.length === 0
      ) {
        invalidLines += 1;
        continue;
      }
      records.push({
        id: raw.id,
        title: raw.title,
        gapType: typeof raw.gapType === 'string' ? raw.gapType : 'unknown',
        targetFile: typeof raw.targetFile === 'string' ? raw.targetFile : '',
        observable: raw.observable,
        passed: raw.passed.map(String),
        at: typeof raw.at === 'string' ? raw.at : '',
      });
    } catch {
      invalidLines += 1;
    }
  }
  return { records, invalidLines };
}

export function loadExemplars(filePath: string): { records: ExemplarRecord[]; invalidLines: number } {
  try {
    return parseExemplars(readFileSync(filePath, 'utf8'));
  } catch {
    return { records: [], invalidLines: 1 };
  }
}

/** 去重键：id 精确去重；标题/可观察行为做字符二元组相似度。 */
function normalize(value: string): string {
  return value.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function bigrams(value: string): Set<string> {
  const chars = [...normalize(value)];
  const out = new Set<string>();
  for (let i = 0; i + 1 < chars.length; i += 1) out.add(`${chars[i]}${chars[i + 1]}`);
  return out;
}

function similar(a: ExemplarRecord, b: ExemplarRecord): boolean {
  if (a.id === b.id) return true;
  const left = bigrams(`${a.title}${a.observable}`);
  const right = bigrams(`${b.title}${b.observable}`);
  if (left.size === 0 || right.size === 0) return normalize(a.title) === normalize(b.title);
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap += 1;
  return overlap / (left.size + right.size - overlap) >= 0.78;
}

export function renderExemplar(record: ExemplarRecord): string {
  return `- [${record.id}] ${record.title}：${record.observable}`;
}

/** 正例优先按 at 新到旧，id 作确定性锚点；预算按条数和字符双重裁剪。 */
export function selectExemplars(records: ExemplarRecord[], budget: ExemplarBudget): ExemplarSelection {
  const sorted = [...records]
    .filter((record) => record.passed.length > 0 && record.title.trim() && record.observable.trim())
    .sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.at < b.at ? 1 : -1));
  const unique: ExemplarRecord[] = [];
  for (const record of sorted) {
    if (unique.some((existing) => similar(existing, record))) continue;
    unique.push(record);
  }

  const maxItems = Math.max(0, Math.trunc(budget.maxItems));
  const maxChars = Math.max(0, Math.trunc(budget.maxChars));
  const selected: ExemplarRecord[] = [];
  let chars = 0;
  for (const record of unique) {
    if (maxItems > 0 && selected.length >= maxItems) break;
    const line = renderExemplar(record);
    const projected = selected.length === 0 ? line.length : chars + 1 + line.length;
    if (selected.length > 0 && maxChars > 0 && projected > maxChars) break;
    selected.push(record);
    chars = projected;
  }
  const selectedSet = new Set(selected.map((record) => record.id));
  return {
    selected,
    evicted: unique.filter((record) => !selectedSet.has(record.id)),
    chars,
    overflow: selected.length < unique.length,
    invalidLines: 0,
  };
}

export function renderExemplarBlock(selection: ExemplarSelection): string {
  if (selection.selected.length === 0) return '';
  return `【可复用正例（exemplars）】\n${selection.selected.map(renderExemplar).join('\n')}`;
}

// bridge RSI round: exemplar injection verified through session upstream
