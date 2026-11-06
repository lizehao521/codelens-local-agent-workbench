/**
 * Recursive-descent expression evaluator for calc.evaluate.
 * No eval / new Function: the grammar is fixed, numbers are parsed in the requested
 * base, and every operation is bounded. Grammar:
 *
 *   expr    := term (('+' | '-') term)*
 *   term    := factor (('*' | '/' | '%') factor)*
 *   factor  := unary ('^' factor)?            // right associative
 *   unary   := ('-' | '+') unary | primary
 *   primary := number | constant | func '(' expr (',' expr)* ')' | '(' expr ')'
 */

export type EvalError =
  | 'EMPTY_EXPRESSION'
  | 'UNEXPECTED_CHAR'
  | 'UNEXPECTED_END'
  | 'UNKNOWN_FUNCTION'
  | 'DIVISION_BY_ZERO'
  | 'INVALID_NUMBER'
  | 'RESULT_NOT_FINITE'
  | 'TOO_MANY_TERMS';

export type EvalResult =
  | { ok: true; value: number }
  | { ok: false; error: EvalError; message: string; position?: number };

const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E, tau: Math.PI * 2 };

const FUNCTIONS: Record<string, { arity: number | [number, number]; fn: (args: number[]) => number }> = {
  sqrt: { arity: 1, fn: (a) => Math.sqrt(a[0]!) },
  cbrt: { arity: 1, fn: (a) => Math.cbrt(a[0]!) },
  abs: { arity: 1, fn: (a) => Math.abs(a[0]!) },
  round: { arity: [1, 2], fn: (a) => (a.length === 1 ? Math.round(a[0]!) : roundTo(a[0]!, a[1]!)) },
  floor: { arity: 1, fn: (a) => Math.floor(a[0]!) },
  ceil: { arity: 1, fn: (a) => Math.ceil(a[0]!) },
  trunc: { arity: 1, fn: (a) => Math.trunc(a[0]!) },
  sign: { arity: 1, fn: (a) => Math.sign(a[0]!) },
  min: { arity: [1, 32], fn: (a) => Math.min(...a) },
  max: { arity: [1, 32], fn: (a) => Math.max(...a) },
  pow: { arity: 2, fn: (a) => a[0]! ** a[1]! },
  exp: { arity: 1, fn: (a) => Math.exp(a[0]!) },
  log: { arity: [1, 2], fn: (a) => (a.length === 1 ? Math.log(a[0]!) : Math.log(a[0]!) / Math.log(a[1]!)) },
  log2: { arity: 1, fn: (a) => Math.log2(a[0]!) },
  log10: { arity: 1, fn: (a) => Math.log10(a[0]!) },
  ln: { arity: 1, fn: (a) => Math.log(a[0]!) },
  sin: { arity: 1, fn: (a) => Math.sin(a[0]!) },
  cos: { arity: 1, fn: (a) => Math.cos(a[0]!) },
  tan: { arity: 1, fn: (a) => Math.tan(a[0]!) },
  asin: { arity: 1, fn: (a) => Math.asin(a[0]!) },
  acos: { arity: 1, fn: (a) => Math.acos(a[0]!) },
  atan: { arity: 1, fn: (a) => Math.atan(a[0]!) },
  hypot: { arity: [2, 32], fn: (a) => Math.hypot(...a) },
};

const MAX_TERMS = 5000;

function roundTo(value: number, digits: number): number {
  const factor = 10 ** Math.max(0, Math.min(15, Math.trunc(digits)));
  return Math.round(value * factor) / factor;
}

function digitValue(ch: string, base: number): number {
  const code = ch.charCodeAt(0);
  let value: number;
  if (code >= 48 && code <= 57) value = code - 48;
  else if (code >= 65 && code <= 90) value = code - 55;
  else if (code >= 97 && code <= 122) value = code - 87;
  else return -1;
  return value < base ? value : -1;
}

class Parser {
  private pos = 0;
  private terms = 0;

  constructor(
    private readonly input: string,
    private readonly base: number,
  ) {}

  parse(): EvalResult {
    this.skipSpaces();
    if (this.pos >= this.input.length) {
      return { ok: false, error: 'EMPTY_EXPRESSION', message: '表达式为空' };
    }
    const value = this.parseExpr();
    // fail() is the only writer of ok=false and it always captures failure.
    if (!this.ok) return this.failure!;
    this.skipSpaces();
    if (this.pos < this.input.length) {
      return { ok: false, error: 'UNEXPECTED_CHAR', message: `无法解析的字符 "${this.input[this.pos]}"`, position: this.pos };
    }
    if (!Number.isFinite(value)) {
      return { ok: false, error: 'RESULT_NOT_FINITE', message: '计算结果不是有限数' };
    }
    return { ok: true, value };
  }

  private ok = true;
  /** The failure result captured by fail(); parse() returns it when !ok. */
  private failure: EvalResult | null = null;

  private fail(result: EvalResult): number {
    this.ok = false;
    this.failure = result;
    return 0;
  }

  private skipSpaces(): void {
    while (this.pos < this.input.length && /\s/.test(this.input[this.pos]!)) this.pos += 1;
  }

  private peek(): string | undefined {
    return this.input[this.pos];
  }

  private eat(token: string): boolean {
    this.skipSpaces();
    if (this.input.startsWith(token, this.pos)) {
      this.pos += token.length;
      return true;
    }
    return false;
  }

  private parseExpr(): number {
    let left = this.parseTerm();
    if (!this.ok) return left;
    for (;;) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '+' || ch === '-') {
        this.pos += 1;
        const right = this.parseTerm();
        if (!this.ok) return 0;
        left = ch === '+' ? left + right : left - right;
      } else break;
    }
    return left;
  }

  private parseTerm(): number {
    let left = this.parseFactor();
    if (!this.ok) return left;
    for (;;) {
      this.skipSpaces();
      const ch = this.peek();
      if (ch === '*' || ch === '/' || ch === '%') {
        this.pos += 1;
        const right = this.parseFactor();
        if (!this.ok) return 0;
        if (ch === '*') left = left * right;
        else {
          if (right === 0) {
            this.fail({ ok: false, error: 'DIVISION_BY_ZERO', message: '除数不能为 0' });
            return 0;
          }
          left = ch === '/' ? left / right : left % right;
        }
      } else break;
    }
    return left;
  }

  private parseFactor(): number {
    const baseValue = this.parseUnary();
    if (!this.ok) return baseValue;
    this.skipSpaces();
    if (this.peek() === '^') {
      this.pos += 1;
      const exponent = this.parseFactor(); // right associative
      if (!this.ok) return 0;
      return baseValue ** exponent;
    }
    return baseValue;
  }

  private parseUnary(): number {
    this.skipSpaces();
    const ch = this.peek();
    if (ch === '-' || ch === '+') {
      this.pos += 1;
      const value = this.parseUnary();
      if (!this.ok) return 0;
      return ch === '-' ? -value : value;
    }
    return this.parsePrimary();
  }

  private parsePrimary(): number {
    this.terms += 1;
    if (this.terms > MAX_TERMS) {
      this.fail({ ok: false, error: 'TOO_MANY_TERMS', message: '表达式项数超出上限' });
      return 0;
    }
    this.skipSpaces();
    const ch = this.peek();
    if (ch === undefined) {
      this.fail({ ok: false, error: 'UNEXPECTED_END', message: '表达式意外结束' });
      return 0;
    }
    if (ch === '(') {
      this.pos += 1;
      const value = this.parseExpr();
      if (!this.ok) return 0;
      if (!this.eat(')')) {
        this.fail({ ok: false, error: 'UNEXPECTED_CHAR', message: '缺少右括号 ")"' });
        return 0;
      }
      return value;
    }
    if (/[0-9a-zA-Z.]/.test(ch)) return this.parseNumberOrCallable();
    this.fail({ ok: false, error: 'UNEXPECTED_CHAR', message: `无法解析的字符 "${ch}"`, position: this.pos });
    return 0;
  }

  private parseNumberOrCallable(): number {
    const start = this.pos;
    while (this.pos < this.input.length && /[0-9a-zA-Z_.]/.test(this.input[this.pos]!)) this.pos += 1;
    const word = this.input.slice(start, this.pos);
    this.skipSpaces();

    if (this.peek() === '(') {
      // Function call
      const fn = FUNCTIONS[word.toLowerCase()];
      if (!fn) {
        this.fail({ ok: false, error: 'UNKNOWN_FUNCTION', message: `未知函数 "${word}"` });
        return 0;
      }
      this.pos += 1; // consume '('
      const args: number[] = [];
      this.skipSpaces();
      if (this.peek() !== ')') {
        for (;;) {
          const arg = this.parseExpr();
          if (!this.ok) return 0;
          args.push(arg);
          this.skipSpaces();
          if (this.eat(',')) continue;
          break;
        }
      }
      if (!this.eat(')')) {
        this.fail({ ok: false, error: 'UNEXPECTED_CHAR', message: `函数 ${word} 缺少右括号` });
        return 0;
      }
      const arityOk =
        typeof fn.arity === 'number'
          ? args.length === fn.arity
          : args.length >= fn.arity[0] && args.length <= fn.arity[1];
      if (!arityOk) {
        this.fail({
          ok: false,
          error: 'UNKNOWN_FUNCTION',
          message: `函数 ${word} 参数个数不符（期望 ${fn.arity}，收到 ${args.length}）`,
        });
        return 0;
      }
      return fn.fn(args);
    }

    // Constant?
    const constant = CONSTANTS[word.toLowerCase()];
    if (constant !== undefined) return constant;

    // Number literal in the requested base
    if (this.base === 10 && (word === '.' || word === '')) {
      this.fail({ ok: false, error: 'INVALID_NUMBER', message: '数字格式不合法', position: start });
      return 0;
    }
    let intPart = word;
    let fracPart = '';
    const dotIndex = word.indexOf('.');
    if (dotIndex >= 0) {
      intPart = word.slice(0, dotIndex);
      fracPart = word.slice(dotIndex + 1);
      if (fracPart.includes('.')) {
        this.fail({ ok: false, error: 'INVALID_NUMBER', message: '数字格式不合法', position: start });
        return 0;
      }
    }
    let value = 0;
    for (const ch of intPart) {
      const digit = digitValue(ch, this.base);
      if (digit < 0) {
        this.fail({ ok: false, error: 'INVALID_NUMBER', message: `"${ch}" 不是 ${this.base} 进制的有效数字`, position: start });
        return 0;
      }
      value = value * this.base + digit;
    }
    let scale = 1 / this.base;
    for (const ch of fracPart) {
      const digit = digitValue(ch, this.base);
      if (digit < 0) {
        this.fail({ ok: false, error: 'INVALID_NUMBER', message: `"${ch}" 不是 ${this.base} 进制的有效数字`, position: start });
        return 0;
      }
      value += digit * scale;
      scale /= this.base;
    }
    if (intPart === '' && fracPart === '') {
      this.fail({ ok: false, error: 'INVALID_NUMBER', message: '数字格式不合法', position: start });
      return 0;
    }
    return value;
  }
}

export function evaluateExpression(expression: string, base = 10): EvalResult {
  if (base < 2 || base > 36 || !Number.isInteger(base)) {
    return { ok: false, error: 'INVALID_NUMBER', message: '进制必须在 2-36 之间' };
  }
  const parser = new Parser(expression, base);
  const result = parser.parse();
  return result;
}

/** Renders a finite number in the given base (2-36) for display; null when not representable. */
export function toBaseString(value: number, base: number): string | null {
  if (!Number.isFinite(value) || base < 2 || base > 36 || !Number.isInteger(base)) return null;
  if (!Number.isInteger(value)) return null;
  const negative = value < 0;
  let n = Math.abs(value);
  if (n === 0) return '0';
  const digits = '0123456789abcdefghijklmnopqrstuvwxyz';
  let out = '';
  while (n > 0) {
    out = digits[n % base]! + out;
    n = Math.floor(n / base);
  }
  return negative ? `-${out}` : out;
}
