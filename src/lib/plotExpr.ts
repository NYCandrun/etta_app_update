// Safe math-expression evaluator for the `etta-chart` function-plot renderer.
//
// The CSP is `script-src 'self'` (no eval / new Function), and this module is
// the one place a chart spec turns model-authored text into a numeric function.
// So evaluation is a hand-rolled recursive-descent (Pratt) parser that builds a
// pure AST, which is then interpreted by a compiled closure tree. There is NO
// eval, NO `new Function`, NO dynamic code execution anywhere — a test greps
// this source and asserts as much.
//
// Public API: `compileExpr(src)` returns `((x:number)=>number) | null`. It
// NEVER throws: any lexer/parser failure (unknown identifier, bad syntax,
// blown safety bound, proto-pollution name) yields null. The returned function
// is TOTAL: domain errors (1/0, sqrt of a negative, ln of <=0, tan at a pole)
// evaluate to NaN or ±Infinity, never a throw — the renderer treats non-finite
// samples as gaps and breaks the SVG path into subpaths.
//
// Grammar (per the locked brief):
//   expr    := add
//   add     := mul (("+"|"-") mul)*
//   mul     := unary (("*"|"/") unary)*        // implicit mult inserted in lexer
//   unary   := "-" unary | power
//   power   := postfix ("^" unary)?            // ^ RIGHT-associative, and its
//                                              // RHS is a unary so 2^-3 works;
//                                              // binds tighter than a leading
//                                              // unary minus: -x^2 = -(x^2),
//                                              // 2^3^2 = 512, (-3)^2 = 9.
//   postfix := number | "x" | const | func "(" expr ")" | "(" expr ")"
//
// Safety bounds (all enforced before or during parse, constants below):
//   - source length cap                        SRC_MAX   = 256
//   - token count cap                           TOKEN_MAX = 512
//   - paren / recursion depth cap               DEPTH_MAX = 32
//   - single-pass anchored character scan in the lexer (no alternation-
//     repetition regex) => no ReDoS; 'x'.repeat(10000) and 10000 '(' return
//     null fast with no hang or stack overflow.
// Function/constant lookup is via a null-prototype map + Object.hasOwn, so
// '__proto__(x)', 'constructor(x)', 'hasOwnProperty(x)' resolve to nothing and
// the parse returns null (never reaches Object.prototype).

export const SRC_MAX = 256;
export const TOKEN_MAX = 512;
export const DEPTH_MAX = 32;

// Unary numeric functions. Null-prototype map: membership is decided ONLY by
// Object.hasOwn, so inherited names ('__proto__', 'constructor', 'toString',
// 'hasOwnProperty') are never resolvable. `log` is base-10 by convention (the
// prompt tells the model to prefer ln / log10 / log2 explicitly).
const FUNCS: Record<string, (v: number) => number> = Object.assign(
  Object.create(null) as Record<string, (v: number) => number>,
  {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    sinh: Math.sinh,
    cosh: Math.cosh,
    tanh: Math.tanh,
    exp: Math.exp,
    ln: Math.log,
    log: (v: number) => Math.log10(v),
    log10: (v: number) => Math.log10(v),
    log2: (v: number) => Math.log2(v),
    sqrt: Math.sqrt,
    abs: Math.abs,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
  },
);

// Named constants. Same null-prototype discipline.
const CONSTS: Record<string, number> = Object.assign(
  Object.create(null) as Record<string, number>,
  { pi: Math.PI, e: Math.E },
);

type TokKind = "num" | "ident" | "op" | "lparen" | "rparen";
interface Token {
  kind: TokKind;
  value: string;
  num?: number;
}

// Single-pass, anchored character scan. Each iteration consumes at least one
// character and advances `i` monotonically, so total work is O(src length) with
// no backtracking — structurally ReDoS-free. Returns null on any illegal
// character or when the token cap is exceeded.
function tokenize(src: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const n = src.length;

  const isDigit = (c: string) => c >= "0" && c <= "9";
  const isAlpha = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");

  while (i < n) {
    const c = src[i] as string;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      i += 1;
      continue;
    }

    if (tokens.length >= TOKEN_MAX) return null;

    // Number: digits with an optional single '.' and optional exponent
    // (1, 1.5, .5, 1e3, 1.5e-3). Scanned character-by-character (no regex).
    if (isDigit(c) || (c === "." && isDigit(src[i + 1] ?? ""))) {
      const start = i;
      let seenDot = false;
      while (i < n) {
        const d = src[i] as string;
        if (isDigit(d)) {
          i += 1;
        } else if (d === "." && !seenDot) {
          seenDot = true;
          i += 1;
        } else {
          break;
        }
      }
      // Optional exponent.
      if (i < n && (src[i] === "e" || src[i] === "E")) {
        let j = i + 1;
        if (src[j] === "+" || src[j] === "-") j += 1;
        if (isDigit(src[j] ?? "")) {
          j += 1;
          while (j < n && isDigit(src[j] as string)) j += 1;
          i = j;
        }
        // else: no digits after 'e' — leave 'e' for the ident scan (constant e).
      }
      const text = src.slice(start, i);
      const num = Number(text);
      if (!Number.isFinite(num)) return null;
      tokens.push({ kind: "num", value: text, num });
      continue;
    }

    // Identifier: a letter followed by letters/digits (so log10, log2, asin are
    // ONE ident). Adjacent letters are ONE identifier ("xy", "pix" => one
    // unknown ident => null later), never silently split.
    if (isAlpha(c)) {
      const start = i;
      i += 1;
      while (i < n && (isAlpha(src[i] as string) || isDigit(src[i] as string))) {
        i += 1;
      }
      tokens.push({ kind: "ident", value: src.slice(start, i) });
      continue;
    }

    if (c === "(") {
      tokens.push({ kind: "lparen", value: c });
      i += 1;
      continue;
    }
    if (c === ")") {
      tokens.push({ kind: "rparen", value: c });
      i += 1;
      continue;
    }
    if (c === "+" || c === "-" || c === "*" || c === "/" || c === "^") {
      tokens.push({ kind: "op", value: c });
      i += 1;
      continue;
    }

    // Any other character (letters handled above) is illegal.
    return null;
  }

  return tokens;
}

// Insert implicit-multiplication '*' tokens. ONLY between:
//   - number  then (ident | func | lparen)        2x, 2sin(x), 2(x+1)
//   - rparen  then (ident | func | number | lparen)  (x+1)(x-1), (x+1)2, (x+1)x
// Adjacent identifiers are NOT joined here — "xy" is already one ident token
// (unknown => null), so there is no "x y" case to split. This keeps implicit
// multiplication strictly to the brief's two rules.
function insertImplicitMul(tokens: Token[]): Token[] {
  const out: Token[] = [];
  for (let k = 0; k < tokens.length; k += 1) {
    const cur = tokens[k] as Token;
    const prev = out[out.length - 1];
    if (prev) {
      const prevEndsOperand = prev.kind === "num" || prev.kind === "rparen";
      const curStartsOperand =
        cur.kind === "num" || cur.kind === "ident" || cur.kind === "lparen";
      // A number directly followed by another number ("2 3") is not a valid
      // product and is left alone so the parser rejects it.
      const numThenNum = prev.kind === "num" && cur.kind === "num";
      if (prevEndsOperand && curStartsOperand && !numThenNum) {
        out.push({ kind: "op", value: "*" });
      }
    }
    out.push(cur);
  }
  return out;
}

// AST node -> compiled closure. Each node is already a `(x)=>number`, so the
// interpreter IS the compiled tree (no separate eval pass, no dynamic dispatch).
type Fn = (x: number) => number;

class Parser {
  private pos = 0;
  private depth = 0;
  constructor(private readonly toks: Token[]) {}

  private peek(): Token | undefined {
    return this.toks[this.pos];
  }
  private next(): Token | undefined {
    const t = this.toks[this.pos];
    this.pos += 1;
    return t;
  }
  private enter(): boolean {
    this.depth += 1;
    return this.depth <= DEPTH_MAX;
  }
  private leave(): void {
    this.depth -= 1;
  }

  // Entry: parse a full expression and require all tokens consumed.
  parse(): Fn | null {
    const fn = this.parseAdd();
    if (fn === null) return null;
    if (this.pos !== this.toks.length) return null; // trailing garbage
    return fn;
  }

  private parseAdd(): Fn | null {
    if (!this.enter()) return null;
    let left = this.parseMul();
    if (left === null) {
      this.leave();
      return null;
    }
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        const right = this.parseMul();
        if (right === null) {
          this.leave();
          return null;
        }
        const l: Fn = left;
        const r: Fn = right;
        left = t.value === "+" ? (x) => l(x) + r(x) : (x) => l(x) - r(x);
      } else {
        break;
      }
    }
    this.leave();
    return left;
  }

  private parseMul(): Fn | null {
    if (!this.enter()) return null;
    let left = this.parseUnary();
    if (left === null) {
      this.leave();
      return null;
    }
    for (;;) {
      const t = this.peek();
      if (t?.kind === "op" && (t.value === "*" || t.value === "/")) {
        this.next();
        const right = this.parseUnary();
        if (right === null) {
          this.leave();
          return null;
        }
        const l: Fn = left;
        const r: Fn = right;
        left = t.value === "*" ? (x) => l(x) * r(x) : (x) => l(x) / r(x);
      } else {
        break;
      }
    }
    this.leave();
    return left;
  }

  // Unary minus binds LOOSER than '^' on its left operand: -x^2 parses as
  // -(x^2). We do this by having unary parse a `power` for its operand, and
  // `power` itself does NOT consume a leading '-'.
  // enter()/leave() so DEPTH_MAX genuinely bounds the self-recursive unary
  // production (a leading-sign chain like "----x") — not just the paren/add/mul
  // paths. Matches the parseAdd/parseMul wrapper pattern.
  private parseUnary(): Fn | null {
    if (!this.enter()) return null;
    const r = this.parseUnaryInner();
    this.leave();
    return r;
  }

  private parseUnaryInner(): Fn | null {
    const t = this.peek();
    if (t?.kind === "op" && t.value === "-") {
      this.next();
      const operand = this.parseUnary();
      if (operand === null) return null;
      const o = operand;
      return (x) => -o(x);
    }
    if (t?.kind === "op" && t.value === "+") {
      // Unary plus: no-op.
      this.next();
      return this.parseUnary();
    }
    return this.parsePower();
  }

  // '^' is RIGHT-associative and its right operand is a `unary`, so 2^-3 and
  // 2^3^2 (=2^(3^2)=512) work. The base is a postfix (no leading sign), so
  // (-3)^2 = 9 needs the parens (which postfix handles) while -3^2 = -9 falls
  // out of unary wrapping power. enter()/leave() so a right-assoc '^' chain
  // (2^2^...^2) is bounded by DEPTH_MAX too.
  private parsePower(): Fn | null {
    if (!this.enter()) return null;
    const r = this.parsePowerInner();
    this.leave();
    return r;
  }

  private parsePowerInner(): Fn | null {
    const base = this.parsePostfix();
    if (base === null) return null;
    const t = this.peek();
    if (t?.kind === "op" && t.value === "^") {
      this.next();
      const exp = this.parseUnary();
      if (exp === null) return null;
      const b = base;
      const e = exp;
      return (x) => Math.pow(b(x), e(x));
    }
    return base;
  }

  private parsePostfix(): Fn | null {
    if (!this.enter()) return null;
    const result = this.parsePostfixInner();
    this.leave();
    return result;
  }

  private parsePostfixInner(): Fn | null {
    const t = this.next();
    if (!t) return null;

    if (t.kind === "num") {
      const v = t.num as number;
      return () => v;
    }

    if (t.kind === "lparen") {
      const inner = this.parseAdd();
      if (inner === null) return null;
      const close = this.next();
      if (close?.kind !== "rparen") return null;
      return inner;
    }

    if (t.kind === "ident") {
      const name = t.value;
      const nxt = this.peek();
      // Function call: ident immediately followed by '('.
      if (nxt?.kind === "lparen") {
        // Null-prototype / hasOwn gate: unknown or inherited names -> null.
        if (!Object.hasOwn(FUNCS, name)) return null;
        const fn = FUNCS[name] as (v: number) => number;
        this.next(); // consume '('
        const arg = this.parseAdd();
        if (arg === null) return null;
        const close = this.next();
        if (close?.kind !== "rparen") return null;
        const a = arg;
        return (x) => fn(a(x));
      }
      // Bare identifier: the variable x, or a named constant.
      if (name === "x") return (x) => x;
      if (Object.hasOwn(CONSTS, name)) {
        const c = CONSTS[name] as number;
        return () => c;
      }
      // Unknown bare identifier (including a function name used without parens,
      // or a multi-letter run like "xy") -> null.
      return null;
    }

    return null;
  }
}

// Compile an expression source to a total numeric function, or null on any
// failure. Never throws.
export function compileExpr(src: string): Fn | null {
  if (typeof src !== "string") return null;
  if (src.length === 0 || src.length > SRC_MAX) return null;

  const raw = tokenize(src);
  if (raw === null || raw.length === 0) return null;

  const toks = insertImplicitMul(raw);
  if (toks.length > TOKEN_MAX) return null;

  const fn = new Parser(toks).parse();
  return fn;
}
