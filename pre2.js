/*! Pre 2 — 書いたそばから、全部見える小さな言語。依存なし・eval なし */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pre2 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';
/* ---- core1_lexer.js ---- */
/* ============================================================
   Pre 2 — エラーと字句解析
   ============================================================ */
class PreError {
  constructor(kind, message, line, col) {
    this.kind = kind;
    this.message = message;
    this.line = line == null ? null : line;
    this.col = col == null ? null : col;
    this.trace = [];
    this.fatal = false;
  }
}

const KEYWORDS = new Set(['state', 'fn', 'if', 'else', 'for', 'in', 'while', 'break', 'return', 'and', 'or', 'not', 'true', 'false', 'null', 'show']);

// 他の言語にあって Pre にない言葉。うっかり書いたときに「Pre ではこう書く」と案内する
const NO_CLASS = 'Pre に class はありません。レコード {name: "Aya"} と関数で書きます';
const NO_TRY = 'Pre に try / catch はありません。エラーはそのまま画面に出ます (自分で止めたいときは fail("理由"))';
const NO_LET = 'Pre に let / const / var はありません。`x = 1` と書くだけで変数になります (実行をまたいで残したい値は `state x = 1`)';
const NO_MATCH = 'Pre に match / switch はありません。if / else if で書きます';
const NO_MODULE = 'Pre にモジュールはありません。1 つのプログラムに全部書きます';
const WORD_HELP = {
  let: NO_LET, const: NO_LET, var: NO_LET,
  class: NO_CLASS, extends: NO_CLASS, new: NO_CLASS, this: NO_CLASS, super: NO_CLASS,
  try: NO_TRY, catch: NO_TRY, finally: NO_TRY, throw: NO_TRY,
  match: NO_MATCH, switch: NO_MATCH, case: NO_MATCH,
  elif: 'else if と書きます',
  continue: 'Pre に continue はありません。if で囲んでください',
  def: '関数は `fn name(a, b) { ... }` と書きます', function: '関数は `fn name(a, b) { ... }` と書きます',
  import: NO_MODULE, export: NO_MODULE, require: NO_MODULE,
  async: 'Pre に async / await はありません。時間は `time` という値で読みます',
  await: 'Pre に async / await はありません。時間は `time` という値で読みます',
};

const ID_RE = /[\p{L}_][\p{L}\p{N}_]*/uy;
const NUM_RE = /\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
const OPS3 = new Set(['..<']);
const OPS2 = new Set(['**', '==', '!=', '<=', '>=', '=>', '|>', '..', '+=', '-=', '*=', '/=', '%=']);
const OPS1 = '+-*/%=<>?:,.()[]{};';
const CLOSERS = { ')': '(', ']': '[', '}': '{' };

// 文字や記号の並びごとの案内 (長いものから順に調べる)
const SEQ_HELP = [
  ['===', '`==` と書きます (Pre の == はリストやレコードも中身で比べます)'],
  ['!==', '`!=` と書きます'],
  ['&&', '`&&` ではなく `and` と書きます'],
  ['||', '`||` ではなく `or` と書きます'],
  ['++', '`x += 1` と書きます (++ はありません)'],
  ['--', '`x -= 1` と書きます (-- はありません)'],
  ['??', '`??` はありません。`a or b` で「なければ b」になります'],
  ['?.', '`?.` はありません。null かもしれないときは if で確かめてください'],
  ['/*', 'コメントは `//` だけです'],
  ['#', 'コメントは `//` です'],
  ["'", '文字列は "..." で囲みます (\' は使えません)'],
  ['`', '文字列は "..." で囲みます。値は "合計 {total}" のように埋め込めます'],
  ['!', '否定は `not` と書きます (例: not done)'],
  ['|', '`|` は使えません。「または」は `or`、関数への受け渡しは `|>` です'],
  ['&', '`&` は使えません。「かつ」は `and` と書きます'],
];

// f"{値:書式}" の「:書式」を切り出す (三項演算子の ':' や括弧の中の ':' は書式とみなさない)
function splitFormatSpec(s) {
  let depth = 0, tern = false;
  for (let k = 0; k < s.length; k++) {
    const ch = s[k];
    if (ch === '"') {
      k++;
      while (k < s.length && s[k] !== '"') { if (s[k] === '\\') k++; k++; }
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (depth === 0) {
      if (ch === '?') tern = true;
      else if (ch === ':' && !tern) return { expr: s.slice(0, k), spec: s.slice(k + 1) };
    }
  }
  return { expr: s, spec: null };
}

/**
 * ソースをトークン列にする。
 * token = { t: 'num'|'str'|'tpl'|'id'|'kw'|'op'|'nl'|'eof', v, line, col, pos, end }
 * 'tpl' の v は [文字列 | {src, line, col, spec}] の配列 ("..." の中に {式} があるとき)
 */
function lex(src, line0, col0) {
  const toks = [];
  const n = src.length;
  let i = 0;
  let line = line0 || 1;
  let ls = 1 - (col0 || 1); // col = i - ls + 1
  const stack = [];
  const fail = (msg, l, c) => { throw new PreError('SyntaxError', msg, l, c); };
  const add = (t, v, l, c, pos) => { toks.push({ t, v, line: l, col: c, pos, end: i }); };
  const pushNl = (l, c) => { const last = toks[toks.length - 1]; if (last && last.t !== 'nl') { toks.push({ t: 'nl', v: '\n', line: l, col: c, pos: i, end: i }); } };

  // 次の行が式の続き (.foo や |> や and など) かどうか
  const continues = (j) => {
    for (;;) {
      while (j < n && (src[j] === ' ' || src[j] === '\t' || src[j] === '\r' || src[j] === '\n')) j++;
      if (src[j] === '/' && src[j + 1] === '/') { while (j < n && src[j] !== '\n') j++; continue; }
      break;
    }
    if (j >= n) return false;
    const c = src[j], d = src[j + 1];
    if (c === '.' && d !== '.' && !(d >= '0' && d <= '9')) return true;
    if (c === '|' && d === '>') return true;
    if (c === '?' || c === ':') return true;
    ID_RE.lastIndex = j;
    const m = ID_RE.exec(src);
    return !!m && (m[0] === 'and' || m[0] === 'or');
  };

  const skipQuoted = (j) => {
    j++;
    while (j < n && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
    return j + 1;
  };
  const scanBalanced = (j, sl, sc) => {
    let depth = 1;
    while (j < n) {
      const c = src[j];
      if (c === '"') { j = skipQuoted(j); continue; }
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return j; }
      j++;
    }
    fail('文字列の中の { が閉じられていません (文字として { を書くときは \\{ です)', sl, sc);
  };
  const readEscape = (sl, sc) => {
    const e = src[i++];
    switch (e) {
      case 'n': return '\n';
      case 't': return '\t';
      case '"': return '"';
      case '\\': return '\\';
      case '{': return '{';
      case '}': return '}';
      default: return fail(`文字列の中の \\${e === undefined ? '' : e} は使えません (使えるのは \\n \\t \\" \\\\ \\{ \\})`, sl, sc);
    }
  };

  while (i < n) {
    const c = src[i];
    const col = i - ls + 1;
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\n') {
      const top = stack.length ? stack[stack.length - 1].ch : '';
      const l0 = line;
      i++; line++; ls = i;
      if (top === '(' || top === '[') continue;
      if (!continues(i)) pushNl(l0, col);
      continue;
    }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }

    // 文字列: いつでも {式} を埋め込める。複数行もそのまま書ける
    if (c === '"') {
      const sl = line, start = i;
      i++;
      let cur = '';
      const parts = [];
      let hasExpr = false;
      for (;;) {
        if (i >= n) fail('文字列が閉じられていません', sl, col);
        const ch = src[i];
        if (ch === '"') { i++; break; }
        if (ch === '\n') { line++; ls = i + 1; cur += ch; i++; continue; }
        if (ch === '\\') { const ec = i - ls + 1; i++; cur += readEscape(line, ec); continue; }
        if (ch === '{') {
          const exprStart = i + 1;
          const startCol = exprStart - ls + 1;
          const startLine = line;
          const end = scanBalanced(exprStart, line, i - ls + 1);
          const exprSrc = src.slice(exprStart, end);
          if (exprSrc.trim() === '') fail('{ } の中が空です。値を書くか、文字としての { は \\{ と書いてください', line, i - ls + 1);
          const sp = splitFormatSpec(exprSrc);
          parts.push(cur); cur = '';
          parts.push({ src: sp.expr, line: startLine, col: startCol, spec: sp.spec });
          hasExpr = true;
          for (let k = 0; k < exprSrc.length; k++) if (exprSrc[k] === '\n') { line++; ls = exprStart + k + 1; }
          i = end + 1;
          continue;
        }
        cur += ch; i++;
      }
      if (hasExpr) { if (cur) parts.push(cur); add('tpl', parts.filter((p) => p !== ''), sl, col, start); }
      else add('str', cur, sl, col, start);
      continue;
    }

    if (c >= '0' && c <= '9') {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      const start = i;
      i += m[0].length;
      if (i < n && /[\p{L}_]/u.test(src[i])) fail('数値の直後に文字を続けることはできません', line, col);
      add('num', Number(m[0].replace(/_/g, '')), line, col, start);
      continue;
    }

    ID_RE.lastIndex = i;
    const im = ID_RE.exec(src);
    if (im) {
      const start = i;
      i += im[0].length;
      add(KEYWORDS.has(im[0]) ? 'kw' : 'id', im[0], line, col, start);
      continue;
    }

    let op = null;
    const s3 = src.substr(i, 3), s2 = src.substr(i, 2);
    if (OPS3.has(s3)) op = s3;
    else {
      for (const [seq, help] of SEQ_HELP) {
        if (!src.startsWith(seq, i)) continue;
        if (seq === '!' && src[i + 1] === '=') continue; // != は普通の演算子
        if (seq === '|' && src[i + 1] === '>') continue; // |> も普通の演算子
        fail(help, line, col);
      }
      if (OPS2.has(s2)) op = s2;
      else if (OPS1.indexOf(c) >= 0) op = c;
      else fail(`使えない文字 '${c}' があります`, line, col);
    }
    const start = i;
    if (op === '(' || op === '[' || op === '{') stack.push({ ch: op, line, col });
    else if (op === ')' || op === ']' || op === '}') {
      const top = stack.pop();
      if (!top || top.ch !== CLOSERS[op]) fail(`対応する開き括弧のない '${op}' があります`, line, col);
    }
    i += op.length;
    add('op', op, line, col, start);
  }
  if (stack.length) { const o = stack[stack.length - 1]; fail(`'${o.ch}' が閉じられていません`, o.line, o.col); }
  pushNl(line, i - ls + 1);
  add('eof', '', line, i - ls + 1, i);
  return toks;
}

/* ---- core2_parser.js ---- */
/* ============================================================
   Pre 2 — 構文解析 (再帰下降)
   ============================================================ */
const PREC = { or: 2, and: 3, cmp: 5, range: 6, add: 10, mul: 11 };
const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);
// これらの記号が続くなら、let や class などの言葉も「ただの変数名」として扱う
const CONTINUES = new Set(['=', '(', '.', '[', ',', ')', ']', '}', ':', ';', '==', '!=', '<', '>', '<=', '>=', '+', '-', '*', '/', '%', '**', '|>', '..', '..<', '?', '+=', '-=', '*=', '/=', '%=', '=>']);

// 文として単独で書いても、画面にも変数にも何も起こさない式の種類
const PURE_EXPR = new Set(['Lit', 'Tpl', 'Id', 'Binary', 'Compare', 'Unary', 'Range', 'List', 'ListComp', 'Record']);
class Parser {
  constructor(toks, src) { this.toks = toks; this.src = src || ''; this.p = 0; this.depth = 0; this.loops = 0; this.fns = 0; }
  get tok() { return this.toks[this.p]; }
  peekTok(k) { return this.toks[Math.min(this.p + (k || 1), this.toks.length - 1)]; }
  next() { const t = this.toks[this.p]; if (t.t !== 'eof') this.p++; return t; }
  isOp(v) { const t = this.toks[this.p]; return t.t === 'op' && t.v === v; }
  isKw(v) { const t = this.toks[this.p]; return t.t === 'kw' && t.v === v; }
  eatOp(v) { if (this.isOp(v)) { this.p++; return true; } return false; }
  eatKw(v) { if (this.isKw(v)) { this.p++; return true; } return false; }
  fail(msg, t) { t = t || this.tok; throw new PreError('SyntaxError', msg, t.line, t.col); }
  desc(t) {
    switch (t.t) {
      case 'eof': return 'ファイルの終わり';
      case 'nl': return '改行';
      case 'str': case 'tpl': return '文字列';
      case 'num': return '数値 ' + t.v;
      default: return "'" + t.v + "'";
    }
  }
  // 式の途中に if が出てきたら (Python の `a if c else b`)、Pre の三項式を案内する
  ifHint(t) { return t.t === 'kw' && t.v === 'if' ? ' → 条件で値を選ぶときは `条件 ? 値1 : 値2` と書きます (例: n > 3 ? "多い" : "少ない")' : ''; }
  expectOp(v, what) {
    if (!this.eatOp(v)) this.fail(`${what || "'" + v + "'"} が必要ですが、${this.desc(this.tok)} が見つかりました${this.ifHint(this.tok)}`);
  }
  skipNl() { while (this.tok.t === 'nl') this.p++; }
  skipTerms() { while (this.tok.t === 'nl' || this.isOp(';')) this.p++; }
  endStmt() {
    const t = this.tok;
    if (t.t === 'nl' || t.t === 'eof' || (t.t === 'op' && (t.v === ';' || t.v === '}'))) return;
    const prev = this.toks[this.p - 1];
    const word = prev && prev.t === 'id' && WORD_HELP[prev.v];
    const help = word ? ` → ${WORD_HELP[prev.v]}` : this.ifHint(t);
    this.fail(`${this.desc(t)} は予期しない位置にあります (文は改行で区切ります)${help}`, word ? prev : t);
  }
  mkBlock(body, tok) {
    const fns = body.filter((s) => s.t === 'FnDecl');
    return { t: 'Block', body, fns: fns.length ? fns : null, line: tok.line };
  }

  parseProgram() {
    const first = this.tok;
    const body = [];
    this.skipTerms();
    while (this.tok.t !== 'eof') { body.push(this.parseStatement()); this.skipTerms(); }
    return this.mkBlock(body, first);
  }
  parseBlock(what) {
    const open = this.tok;
    if (!this.isOp('{')) this.fail(`${what || 'ブロック'}の後には { が必要ですが、${this.desc(this.tok)} が見つかりました`);
    this.next();
    this.depth++;
    const body = [];
    this.skipTerms();
    while (!this.isOp('}')) {
      if (this.tok.t === 'eof') this.fail("'}' が見つかりません (ブロックが閉じられていません)", open);
      body.push(this.parseStatement());
      this.skipTerms();
    }
    this.next();
    this.depth--;
    return this.mkBlock(body, open);
  }

  parseStatement() {
    const t = this.tok;
    if (t.t === 'id' && WORD_HELP[t.v]) {
      const nx = this.peekTok();
      const cont = nx.t === 'nl' || nx.t === 'eof' || (nx.t === 'op' && CONTINUES.has(nx.v));
      if (!cont) this.fail(WORD_HELP[t.v], t);
    }
    if (t.t === 'op' && t.v === '{') this.fail('ここに { } は書けません ({ } は if / for / while / fn の後ろにだけ書けます)');
    if (t.t === 'kw') {
      switch (t.v) {
        case 'state': return this.parseState();
        case 'fn':
          if (this.peekTok().t === 'id') {
            this.next();
            const name = this.next().v;
            const f = this.parseFunction(name, t);
            f.t = 'FnDecl';
            if (f.exprBody) this.endStmt();
            return f;
          }
          this.fail('無名関数は `x => x * 2` や `(a, b) => a + b` と書きます (fn の後ろには関数名が必要です)');
          break;
        case 'if': return this.parseIf();
        case 'while': {
          this.next();
          const cond = this.parseExpr();
          this.loops++;
          const body = this.parseBlock('while の条件');
          this.loops--;
          return { t: 'While', cond, body, line: t.line, col: t.col };
        }
        case 'for': return this.parseFor();
        case 'return': {
          if (!this.fns) this.fail('return は関数 (fn) の中でだけ使えます。画面に出したいときは show を使います');
          this.next();
          let arg = null;
          const k = this.tok;
          if (!(k.t === 'nl' || k.t === 'eof' || (k.t === 'op' && (k.v === ';' || k.v === '}')))) arg = this.parseExpr();
          this.endStmt();
          return { t: 'Return', arg, line: t.line, col: t.col };
        }
        case 'break':
          if (!this.loops) this.fail('break はくり返し (for / while) の中でだけ使えます');
          this.next(); this.endStmt();
          return { t: 'Break', line: t.line, col: t.col };
        case 'show': {
          this.next();
          if (this.tok.t === 'nl' || this.tok.t === 'eof') this.fail('show の後には表示したい値が必要です (例: show "こんにちは")');
          const arg = this.parseExpr();
          this.endStmt();
          return { t: 'Show', arg, line: t.line, col: t.col };
        }
        default: break;
      }
    }
    const expr = this.parseExpr();
    this.endStmt();
    // 計算するだけで何も起きない式 (x * 2 など) は、ほぼ書き間違い。関数の最後に return を忘れたときに気づける
    if (PURE_EXPR.has(expr.t)) this.fail('この式は計算するだけで、値がどこにも使われていません。関数から値を返すなら return を、画面に出すなら show を書きます', t);
    return { t: 'Expr', expr, line: t.line, col: t.col };
  }

  parseState() {
    const kw = this.next();
    if (this.depth > 0) this.fail('state はプログラムの一番外側でだけ宣言できます (関数や if / for の中では使えません)', kw);
    if (this.tok.t !== 'id') this.fail(`state の後には変数名が必要です (例: state n = 0)。${this.desc(this.tok)} が見つかりました`);
    const name = this.next().v;
    if (!this.isOp('=')) this.fail(`state には初期値が必要です (state ${name} = 0 のように書きます)`);
    this.next(); this.skipNl();
    const startTok = this.tok;
    const init = this.parseExpr();
    const initSrc = this.src.slice(startTok.pos, this.toks[this.p - 1].end);
    this.endStmt();
    return { t: 'State', name, init, initSrc, line: kw.line, col: kw.col };
  }

  parseIf() {
    const t = this.next();
    const cond = this.parseExpr();
    const then = this.parseBlock('if の条件');
    let alt = null;
    const save = this.p;
    this.skipNl();
    if (this.isKw('else')) {
      this.next();
      if (this.isKw('if')) alt = this.parseIf();
      else alt = this.parseBlock('else');
    } else this.p = save;
    return { t: 'If', cond, then, else: alt, line: t.line, col: t.col };
  }

  parseNames() {
    const names = [];
    for (;;) {
      if (this.tok.t !== 'id') this.fail(`変数名が必要ですが、${this.desc(this.tok)} が見つかりました (例: for x in 1..5 { ... })`);
      names.push(this.next().v);
      if (names.length === 2 || !this.eatOp(',')) break;
    }
    return names;
  }
  parseFor() {
    const t = this.next();
    const names = this.parseNames();
    if (!this.eatKw('in')) this.fail(`'in' が必要ですが、${this.desc(this.tok)} が見つかりました (for x in リスト { ... } の形で書きます)`);
    const iter = this.parseExpr();
    this.loops++;
    const body = this.parseBlock('for の範囲');
    this.loops--;
    return { t: 'For', names, iter, body, line: t.line, col: t.col };
  }

  /* ── 関数 ── */
  parseParams() {
    this.expectOp('(');
    const params = [];
    this.skipNl();
    while (!this.isOp(')')) {
      const pt = this.tok;
      if (pt.t !== 'id') this.fail(`引数名が必要ですが、${this.desc(pt)} が見つかりました`);
      this.next();
      let def = null;
      if (this.eatOp('=')) def = this.parseTernary();
      params.push({ name: pt.v, def, line: pt.line });
      this.skipNl();
      if (!this.eatOp(',')) break;
      this.skipNl();
    }
    this.expectOp(')', "引数リストの ')'");
    return params;
  }
  arity(params) {
    let min = 0, sawOpt = false;
    for (const p of params) { if (p.def) sawOpt = true; else if (sawOpt) this.fail(`初期値のない引数 '${p.name}' を、初期値のある引数の後ろには置けません`); else min++; }
    return [min, params.length];
  }
  withFnScope(fn) {
    const d = this.depth, l = this.loops;
    this.depth = d + 1; this.loops = 0;
    try { return fn(); } finally { this.depth = d; this.loops = l; }
  }
  parseFunction(name, startTok) {
    const params = this.parseParams();
    let body, exprBody = false;
    this.fns++;
    if (this.isOp('=>')) { this.next(); this.skipNl(); body = this.withFnScope(() => this.parseAssign()); exprBody = true; }
    else { const d = this.depth, l = this.loops; this.loops = 0; this.depth = d; body = this.parseBlock('関数の引数'); this.loops = l; }
    this.fns--;
    const [minArgs, maxArgs] = this.arity(params);
    return { t: 'Fn', name, params, body, exprBody, minArgs, maxArgs, line: startTok.line, col: startTok.col };
  }
  isArrowAhead() {
    let depth = 0;
    for (let k = this.p; k < this.toks.length; k++) {
      const t = this.toks[k];
      if (t.t === 'eof') return false;
      if (t.t === 'op') {
        if (t.v === '(' || t.v === '[' || t.v === '{') depth++;
        else if (t.v === ')' || t.v === ']' || t.v === '}') {
          depth--;
          if (depth === 0) { const nx = this.toks[k + 1]; return !!nx && nx.t === 'op' && nx.v === '=>'; }
        }
      }
    }
    return false;
  }
  finishArrow(params, t) {
    const [minArgs, maxArgs] = this.arity(params);
    let body, exprBody = false;
    this.fns++;
    if (this.isOp('{')) { const l = this.loops; this.loops = 0; body = this.parseBlock('=>'); this.loops = l; }
    else { body = this.withFnScope(() => this.parseAssign()); exprBody = true; }
    this.fns--;
    return { t: 'Fn', name: '', params, body, exprBody, minArgs, maxArgs, line: t.line, col: t.col };
  }

  /* ── 式 ── */
  parseExpr() { return this.parseAssign(); }
  parseAssign() {
    const t = this.tok;
    if (t.t === 'id' && this.peekTok().t === 'op' && this.peekTok().v === '=>') {
      this.next(); this.next(); this.skipNl();
      return this.finishArrow([{ name: t.v, def: null, line: t.line }], t);
    }
    if (t.t === 'op' && t.v === '(' && this.isArrowAhead()) {
      const params = this.parseParams();
      this.expectOp('=>');
      this.skipNl();
      return this.finishArrow(params, t);
    }
    const left = this.parseTernary();
    const ot = this.tok;
    if (ot.t === 'op' && ASSIGN_OPS.has(ot.v)) {
      if (left.t !== 'Id' && left.t !== 'Member' && left.t !== 'Index') this.fail('代入できない式です (変数・要素 xs[0]・レコードの項目 r.name にだけ代入できます)', ot);
      this.next(); this.skipNl();
      const value = this.parseAssign();
      return { t: 'Assign', op: ot.v, target: left, value, line: ot.line, col: ot.col };
    }
    return left;
  }
  parseTernary() {
    const cond = this.parsePipe();
    if (this.isOp('?')) {
      const t = this.next();
      this.skipNl();
      const a = this.parseAssign();
      this.skipNl();
      this.expectOp(':', "三項演算子の ':'");
      this.skipNl();
      const b = this.parseAssign();
      return { t: 'Cond', test: cond, a, b, line: t.line, col: t.col };
    }
    return cond;
  }
  parsePipe() {
    let left = this.parseBinary(1);
    while (this.isOp('|>')) {
      const t = this.next();
      this.skipNl();
      let right;
      if (this.isKw('show')) { const s = this.next(); right = { t: 'ShowRef', line: s.line, col: s.col }; }
      else right = this.parseBinary(1);
      left = { t: 'Pipe', l: left, r: right, line: t.line, col: t.col };
    }
    return left;
  }
  binInfo(t) {
    if (t.t === 'op') {
      if (CMP_OPS.has(t.v)) return { op: t.v, prec: PREC.cmp, cmp: true };
      if (t.v === '..' || t.v === '..<') return { op: t.v, prec: PREC.range, range: true };
      if (t.v === '+' || t.v === '-') return { op: t.v, prec: PREC.add };
      if (t.v === '*' || t.v === '/' || t.v === '%') return { op: t.v, prec: PREC.mul };
      return null;
    }
    if (t.t === 'kw') {
      if (t.v === 'or') return { op: 'or', prec: PREC.or, logical: true };
      if (t.v === 'and') return { op: 'and', prec: PREC.and, logical: true };
      if (t.v === 'in') return { op: 'in', prec: PREC.cmp, cmp: true };
      if (t.v === 'not') { const nx = this.peekTok(); if (nx.t === 'kw' && nx.v === 'in') return { op: 'not in', prec: PREC.cmp, cmp: true, two: true }; }
    }
    return null;
  }
  parseBinary(minPrec) {
    let left;
    if (this.isKw('not') && minPrec <= 4 && !(this.peekTok().t === 'kw' && this.peekTok().v === 'in')) {
      const t = this.next();
      const arg = this.parseBinary(5);
      left = { t: 'Unary', op: 'not', arg, line: t.line, col: t.col };
    } else left = this.parseUnary();
    for (;;) {
      const info = this.binInfo(this.tok);
      if (!info || info.prec < minPrec) break;
      const opTok = this.tok;
      if (info.cmp) {
        const ops = [], operands = [left];
        for (;;) {
          const inf = this.binInfo(this.tok);
          if (!inf || !inf.cmp) break;
          this.next(); if (inf.two) this.next();
          this.skipNl();
          ops.push(inf.op);
          operands.push(this.parseBinary(PREC.range));
        }
        left = { t: 'Compare', ops, operands, line: opTok.line, col: opTok.col };
        continue;
      }
      this.next(); this.skipNl();
      const right = this.parseBinary(info.prec + 1);
      if (info.range) left = { t: 'Range', l: left, r: right, exclusive: info.op === '..<', line: opTok.line, col: opTok.col };
      else left = { t: info.logical ? 'Logical' : 'Binary', op: info.op, l: left, r: right, line: opTok.line, col: opTok.col };
    }
    return left;
  }
  parseUnary() {
    const t = this.tok;
    if (t.t === 'op' && (t.v === '-' || t.v === '+')) {
      this.next();
      const arg = this.parseUnary();
      return { t: 'Unary', op: t.v, arg, line: t.line, col: t.col };
    }
    return this.parsePower();
  }
  parsePower() {
    const base = this.parsePostfix();
    if (this.isOp('**')) {
      const t = this.next();
      this.skipNl();
      return { t: 'Binary', op: '**', l: base, r: this.parseUnary(), line: t.line, col: t.col };
    }
    return base;
  }
  parseArgs() {
    this.expectOp('(');
    const args = [];
    this.skipNl();
    while (!this.isOp(')')) {
      args.push(this.parseAssign());
      this.skipNl();
      if (!this.eatOp(',')) break;
      this.skipNl();
    }
    this.expectOp(')', "関数呼び出しの ')'");
    return args;
  }
  parsePostfix() {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.tok;
      if (t.t !== 'op') break;
      if (t.v === '(') {
        e = { t: 'Call', callee: e, args: this.parseArgs(), line: t.line, col: t.col };
      } else if (t.v === '.') {
        this.next();
        const nt = this.tok;
        if (nt.t !== 'id' && nt.t !== 'kw') this.fail(`項目名が必要ですが、${this.desc(nt)} が見つかりました (例: person.name)`);
        this.next();
        e = { t: 'Member', obj: e, prop: nt.v, line: nt.line, col: nt.col };
      } else if (t.v === '[') {
        this.next();
        let start = null, end = null, isSlice = false;
        if (this.isOp(':')) { isSlice = true; this.next(); if (!this.isOp(']')) end = this.parseAssign(); }
        else {
          start = this.parseAssign();
          if (this.eatOp(':')) { isSlice = true; if (!this.isOp(']')) end = this.parseAssign(); }
        }
        this.expectOp(']', "']'");
        e = isSlice ? { t: 'Slice', obj: e, start, end, line: t.line, col: t.col } : { t: 'Index', obj: e, index: start, line: t.line, col: t.col };
      } else break;
    }
    return e;
  }
  parseTemplateExpr(part) {
    const sub = new Parser(lex(part.src, part.line, part.col), part.src);
    sub.skipNl();
    const e = sub.parseExpr();
    sub.skipNl();
    if (sub.tok.t !== 'eof') sub.fail(`文字列の中の { } に ${sub.desc(sub.tok)} は書けません`);
    return e;
  }
  parsePrimary() {
    const t = this.tok;
    switch (t.t) {
      case 'num': case 'str': this.next(); return { t: 'Lit', v: t.v, line: t.line, col: t.col };
      case 'tpl': {
        this.next();
        const parts = t.v.map((p) => {
          if (typeof p === 'string') return p;
          const e = this.parseTemplateExpr(p);
          return p.spec != null ? { t: 'Fmt', expr: e, spec: p.spec, line: p.line, col: p.col } : e;
        });
        return { t: 'Tpl', parts, line: t.line, col: t.col };
      }
      case 'id': this.next(); return { t: 'Id', name: t.v, line: t.line, col: t.col };
      case 'kw':
        if (t.v === 'true' || t.v === 'false' || t.v === 'null') { this.next(); return { t: 'Lit', v: t.v === 'null' ? null : t.v === 'true', line: t.line, col: t.col }; }
        if (t.v === 'fn') this.fail('無名関数は `x => x * 2` や `(a, b) => a + b` と書きます');
        if (t.v === 'show') this.fail('show は文です。値の途中には書けません (`show 値`、または `値 |> show`)');
        break;
      case 'op':
        if (t.v === '(') {
          this.next(); this.skipNl();
          const e = this.parseExpr();
          this.skipNl();
          this.expectOp(')', "括弧の ')'");
          return e;
        }
        if (t.v === '[') return this.parseList();
        if (t.v === '{') return this.parseRecord();
        break;
      default: break;
    }
    this.fail(`${this.desc(t)} は予期しない位置にあります`);
  }
  parseList() {
    const open = this.next();
    const items = [];
    this.skipNl();
    while (!this.isOp(']')) {
      const e = this.parseAssign();
      if (items.length === 0 && this.isKw('for')) return this.parseComp(e, open);
      items.push(e);
      this.skipNl();
      if (!this.eatOp(',')) break;
      this.skipNl();
    }
    this.skipNl();
    this.expectOp(']', "リストの ']'");
    return { t: 'List', items, line: open.line, col: open.col };
  }
  parseComp(elem, open) {
    this.next(); // for
    const names = this.parseNames();
    if (!this.eatKw('in')) this.fail("内包表記の for には 'in' が必要です (例: [x * 2 for x in xs])");
    const iter = this.parseTernary();
    let cond = null;
    if (this.eatKw('if')) cond = this.parseTernary();
    this.skipNl();
    this.expectOp(']', "リストの ']'");
    return { t: 'ListComp', elem, names, iter, cond, line: open.line, col: open.col };
  }
  parseRecord() {
    const open = this.next();
    const entries = [];
    this.skipNl();
    while (!this.isOp('}')) {
      const t = this.tok;
      let key, short = null;
      if (t.t === 'id') { this.next(); key = t.v; short = t.v; }
      else if (t.t === 'kw' || t.t === 'str' || t.t === 'num') { this.next(); key = t.v; }
      else this.fail(`レコードの項目名が必要ですが、${this.desc(t)} が見つかりました (例: {name: "Aya", age: 20})`);
      let value;
      this.skipNl();
      if (this.eatOp(':')) { this.skipNl(); value = this.parseAssign(); }
      else if (short) value = { t: 'Id', name: short, line: t.line, col: t.col };
      else this.fail("レコードの ':' が必要です");
      entries.push({ key, value });
      this.skipNl();
      if (!this.eatOp(',')) break;
      this.skipNl();
    }
    this.skipNl();
    this.expectOp('}', "レコードの '}'");
    return { t: 'Record', entries, line: open.line, col: open.col };
  }
}

function parse(src) {
  const toks = lex(src, 1, 1);
  try {
    return new Parser(toks, src).parseProgram();
  } catch (e) {
    // 文法エラーのある行が、他の言語の言葉 (switch (x) {...} など) で始まっていたら、Pre での書き方を添える
    if (e instanceof PreError && e.kind === 'SyntaxError' && e.line != null && e.message.indexOf(' → ') < 0) {
      const first = toks.find((t) => t.line === e.line && t.t !== 'nl');
      if (first && first.t === 'id' && WORD_HELP[first.v] && e.message.indexOf(WORD_HELP[first.v]) < 0) e.message += ' → ' + WORD_HELP[first.v];
    }
    throw e;
  }
}

/* ---- core3_values.js ---- */
/* ============================================================
   Pre 2 — 値・表示・比較
   値は number / 文字(string) / bool / null / リスト(Array) / レコード(Map) / 関数 の 7 種類だけ。
   ============================================================ */
const STATE = { state: true }; // スコープの中で「この名前は state」と示す印
class Getter { constructor(get) { this.get = get; } } // time / mouse のように、読むたびに値が決まる組み込み
class PreFn {
  constructor(name, node, scope) { this.name = name; this.node = node; this.scope = scope; }
}
class Scope { constructor(parent) { this.vars = new Map(); this.parent = parent || null; } }
class ReturnSignal { constructor(value) { this.value = value; } }
const BREAK = { sig: 'break' };

const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function lev(a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}
function closest(name, cands) {
  if (name.length < 3) return null;
  let best = null, bd = 99;
  const lname = name.toLowerCase();
  for (const c of cands) { const d = lev(lname, c.toLowerCase()); if (d < bd) { bd = d; best = c; } }
  return best && best !== name && bd <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
}

function typeName(v) {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'number': return 'number';
    case 'string': return 'text';
    case 'boolean': return 'bool';
    case 'function': return 'fn';
    default: break;
  }
  if (Array.isArray(v)) return 'list';
  if (v instanceof Map) return 'record';
  if (v instanceof PreFn) return 'fn';
  return 'unknown';
}
const JP_TYPE = { number: '数値', text: '文字', bool: '真偽値', null: 'null', list: 'リスト', record: 'レコード', fn: '関数', unknown: '不明な値' };
const jp = (v) => JP_TYPE[typeName(v)];

// 表示は有効数字 12 桁で丸める (0.1 + 0.2 が 0.3 と出る)
function fmtNum(x) {
  if (Object.is(x, -0)) return '0';
  if (!Number.isFinite(x)) return String(x);
  if (Number.isInteger(x) && Math.abs(x) < 1e15) return String(x);
  return String(Number(x.toPrecision(12)));
}
const IDENT_ONLY = /^[\p{L}_][\p{L}\p{N}_]*$/u;

function toStr(v) {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string': return v;
    case 'number': return fmtNum(v);
    case 'boolean': return v ? 'true' : 'false';
    default: return repr(v, 0, []);
  }
}
function repr(v, depth, seen) {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'string': return JSON.stringify(v);
    case 'number': return fmtNum(v);
    case 'boolean': return v ? 'true' : 'false';
    case 'function': return `<${v.preName || 'fn'}>`;
    default: break;
  }
  if (Array.isArray(v)) {
    if (seen.indexOf(v) >= 0 || depth > 8) return '[...]';
    seen.push(v);
    const s = '[' + v.map((x) => repr(x, depth + 1, seen)).join(', ') + ']';
    seen.pop();
    return s;
  }
  if (v instanceof Map) {
    if (seen.indexOf(v) >= 0 || depth > 8) return '{...}';
    seen.push(v);
    const parts = [];
    for (const [k, x] of v) parts.push((typeof k === 'string' && IDENT_ONLY.test(k) ? k : JSON.stringify(k)) + ': ' + repr(x, depth + 1, seen));
    seen.pop();
    return '{' + parts.join(', ') + '}';
  }
  if (v instanceof PreFn) return `<fn ${v.name || 'anonymous'}>`;
  return String(v);
}

function truthy(v) {
  if (v === true) return true;
  if (v === false || v === null || v === undefined) return false;
  if (typeof v === 'number') return v !== 0 && v === v;
  if (typeof v === 'string') return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  if (v instanceof Map) return v.size > 0;
  return true;
}
function eq(a, b) {
  if (a === b) return true;
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a !== 'object' || typeof b !== 'object' || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  if (a instanceof Map) {
    if (!(b instanceof Map) || a.size !== b.size) return false;
    for (const [k, x] of a) if (!b.has(k) || !eq(x, b.get(k))) return false;
    return true;
  }
  return false;
}
// 大小の比較。比べられない組み合わせは fail(メッセージ) で止める
function cmp(a, b, fail) {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  if (Array.isArray(a) && Array.isArray(b)) {
    const m = Math.min(a.length, b.length);
    for (let i = 0; i < m; i++) { const c = cmp(a[i], b[i], fail); if (c !== 0) return c; }
    return a.length - b.length;
  }
  return fail(`${jp(a)}と${jp(b)}は大小を比べられません`);
}

const SHAPE_KINDS = new Set(['circle', 'rect', 'line', 'label']);
function isShape(v) { return v instanceof Map && SHAPE_KINDS.has(v.get('kind')); }

/* "{x:.2f}" の書式指定 ([[fill]align][sign][0][width][,][.prec][type]) */
function formatValue(v, spec, fail) {
  const m = /^(?:(.)?([<>^]))?([+\- ])?(0)?(\d+)?(,)?(?:\.(\d+))?([dfFeEgGsxXbo%])?$/u.exec(spec);
  if (!m) fail(`書式 ':${spec}' が正しくありません (例: .2f / 05d / >8 / ^10 / ,)`);
  const [, fillCh, align0, sign, zero, widthS, comma, precS, type] = m;
  const width = widthS ? parseInt(widthS, 10) : 0;
  const prec = precS !== undefined ? parseInt(precS, 10) : null;
  let body, numeric = false;
  if (typeof v === 'number') {
    numeric = true;
    const neg = v < 0 || Object.is(v, -0);
    const a = Math.abs(v);
    switch (type) {
      case 'd': if (!Number.isInteger(v)) fail("書式 'd' は整数にだけ使えます (小数には f を使います)"); body = String(a); break;
      case 'f': case 'F': body = a.toFixed(prec === null ? 6 : prec); break;
      case 'e': case 'E': body = a.toExponential(prec === null ? 6 : prec).replace(/e([+-])(\d)$/, (_, sg, d) => 'e' + sg + '0' + d); if (type === 'E') body = body.toUpperCase(); break;
      case 'g': case 'G': body = prec === null ? fmtNum(a) : String(Number(a.toPrecision(prec || 1))); break;
      case '%': body = (a * 100).toFixed(prec === null ? 6 : prec) + '%'; break;
      case 'x': body = Math.trunc(a).toString(16); break;
      case 'X': body = Math.trunc(a).toString(16).toUpperCase(); break;
      case 'o': body = Math.trunc(a).toString(8); break;
      case 'b': body = Math.trunc(a).toString(2); break;
      case 's': fail("書式 's' は数値には使えません"); break;
      default: body = prec === null ? fmtNum(a) : a.toFixed(prec);
    }
    if (comma) { const parts = body.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); body = parts.join('.'); }
    const sg = neg ? '-' : (sign === '+' ? '+' : sign === ' ' ? ' ' : '');
    if (zero && width && !align0) return sg + '0'.repeat(Math.max(0, width - sg.length - body.length)) + body;
    body = sg + body;
  } else {
    if (type && type !== 's') fail(`書式 '${type}' は数値にだけ使えます (${jp(v)}が渡されました)`);
    body = toStr(v);
    if (prec !== null) body = body.slice(0, prec);
  }
  if (body.length >= width) return body;
  const align = align0 || (numeric ? '>' : '<');
  const fill = fillCh || (zero ? '0' : ' ');
  const pad = width - body.length;
  if (align === '<') return body + fill.repeat(pad);
  if (align === '>') return fill.repeat(pad) + body;
  const left = Math.floor(pad / 2);
  return fill.repeat(left) + body + fill.repeat(pad - left);
}

/* ---- core4_interp.js ---- */
/* ============================================================
   Pre 2 — インタプリタ (木を歩いて実行する)
   プログラムは実行のたびに「上から」新しく実行される。残るのは state だけ。
   ============================================================ */
const MAX_DEPTH = 1000;

// 他の言語の癖で書きがちな名前に、Pre での書き方を案内する
const NAME_HINTS = {
  print: '出力は show を使います (例: show "こんにちは")',
  console: '出力は show を使います (例: show "こんにちは")',
  input: 'Pre に input() はありません。入力は textbox("名前", "") のように、画面の部品で受け取ります',
  prompt: 'Pre に prompt() はありません。入力は textbox("名前", "") のように、画面の部品で受け取ります',
  range: '範囲は 1..5 (5 を含む) や 0..<5 (5 を含まない) と書きます',
  self: 'Pre に self / this はありません',
  True: 'true と小文字で書きます',
  False: 'false と小文字で書きます',
  None: '何もない値は null です',
  undefined: '何もない値は null です',
  nil: '何もない値は null です',
  str: '文字にするには "{x}" と書きます (文字列の中に値を埋め込めます)',
  int: '整数にするには floor(x) か round(x)、文字からは num("12") です',
  float: '文字から数にするには num("1.5") です',
  Math: 'Math はありません。sin や sqrt や floor はそのまま書けます',
  length: '長さは len(x) です',
};
const METHOD_HINTS = {
  length: ' (長さは len(x))', includes: ' (含むかどうかは x in xs)', contains: ' (含むかどうかは x in xs)',
  indexOf: ' (探すには find(xs, x => ...))', toFixed: ' (桁をそろえるなら round(x, 2) か "{x:.2f}")',
  toUpperCase: ' (upper(s))', toLowerCase: ' (lower(s))', forEach: ' (for x in xs { ... })',
  slice: ' (xs[1:3])', concat: ' (xs + ys)', startsWith: ' (s[0:3] == "abc")', endsWith: ' (s[-3:] == "abc")',
  append: ' (push(xs, x))', toString: ' ("{x}")', keys: ': keys(record)', values: ': values(record)',
};

class Interpreter {
  constructor(ctx) {
    this.ctx = ctx;
    ctx.I = this;
    this.depth = 0; this.steps = 0; this.deadline = Infinity; this.line = 0; this.col = null;
    this.timeLimit = ctx.timeLimit || 2000;
    this.top = null;
    this.builtins = makeBuiltins(this);
  }

  fail(kind, msg, n) { throw new PreError(kind, msg, n && n.line != null ? n.line : this.line, n && n.col != null ? n.col : this.col); }
  tick() {
    if ((++this.steps & 0x3ff) === 0 && nowMs() > this.deadline) {
      const e = new PreError('TimeoutError', `実行時間が長すぎます (${(this.timeLimit / 1000).toFixed(1).replace(/\.0$/, '')} 秒)。終わらないくり返しになっていませんか？`, this.line, this.col);
      e.fatal = true;
      throw e;
    }
  }

  run(ast) {
    this.deadline = nowMs() + this.timeLimit;
    this.top = new Scope(null);
    return this.execBlock(ast, this.top);
  }

  /* ── 変数 ── */
  allNames(scope) {
    const s = new Set(this.builtins.keys());
    for (let e = scope; e; e = e.parent) for (const k of e.vars.keys()) s.add(k);
    return Array.from(s);
  }
  lookup(name, scope, n) {
    for (let e = scope; e; e = e.parent) {
      const v = e.vars.get(name);
      if (v !== undefined) return v === STATE ? this.ctx.getState(name) : v;
    }
    const b = this.builtins.get(name);
    if (b !== undefined) return b instanceof Getter ? b.get() : b;
    return this.nameError(name, scope, n);
  }
  nameError(name, scope, n) {
    let msg = `変数 '${name}' は定義されていません`;
    const hint = NAME_HINTS[name] || WORD_HELP[name];
    if (hint) msg += `。${hint}`;
    else { const c = closest(name, this.allNames(scope)); if (c) msg += ` (もしかして: ${c} ?)`; }
    this.fail('NameError', msg, n);
  }
  assignVar(name, v, scope, n) {
    const own = scope.vars.get(name);
    if (own !== undefined) {
      if (own === STATE) this.ctx.setState(name, v); else scope.vars.set(name, v);
      return;
    }
    for (let e = scope.parent; e; e = e.parent) {
      const o = e.vars.get(name);
      if (o === STATE) { this.ctx.setState(name, v); return; }
      if (o !== undefined) {
        this.fail('NameError', `関数の中から、外側の変数 '${name}' は書き換えられません (書き換えられるのは state だけです)。外側の値を変えたいなら state ${name} = ... と宣言してください。関数の中だけで使う値なら、別の名前にしてください`, n);
      }
    }
    if (this.builtins.get(name) instanceof Getter) this.fail('NameError', `'${name}' は読み取り専用の値です`, n);
    scope.vars.set(name, v);
  }
  bindLoop(names, item, scope, n, fresh) {
    if (names.length === 1) { this.setLoopVar(names[0], item, scope, n, fresh); return; }
    if (!Array.isArray(item) || item.length < 2) this.fail('TypeError', `for ${names.join(', ')} in ... は [${names.join(', ')}] の組を取り出します。${jp(item)}は組ではありません (pairs(record) や enumerate(xs) を使います)`, n);
    this.setLoopVar(names[0], item[0], scope, n, fresh);
    this.setLoopVar(names[1], item[1], scope, n, fresh);
  }
  setLoopVar(name, v, scope, n, fresh) {
    if (!fresh && scope.vars.get(name) === STATE) this.fail('NameError', `'${name}' は state なので、for の変数には使えません。別の名前にしてください`, n);
    scope.vars.set(name, v);
  }

  /* ── 呼び出し ── */
  call(f, args, n) {
    if (f instanceof PreFn) return this.callFn(f, args, n);
    if (typeof f === 'function') { const r = f(...args); return r === undefined ? null : r; }
    if (f === null || f === undefined) this.fail('TypeError', 'null は関数として呼び出せません (名前のつづりを確認してください)', n);
    return this.fail('TypeError', `${jp(f)}は関数として呼び出せません`, n);
  }
  // map や filter に渡された関数を呼ぶ。自作の関数には (値, 位置) を、組み込みには値だけを渡す
  callCb(f, x, i) {
    if (f instanceof PreFn) return this.callFn(f, [x, i].slice(0, f.node.maxArgs), null);
    return this.call(f, [x], null);
  }
  callFn(fn, args, n) {
    if (++this.depth > MAX_DEPTH) {
      this.depth--;
      this.fail('RecursionError', `再帰が深すぎます (${MAX_DEPTH} 回を超えました)。終わりの条件を確認してください`, n);
    }
    this.tick();
    const node = fn.node;
    const scope = new Scope(fn.scope);
    try {
      if (args.length < node.minArgs || args.length > node.maxArgs) {
        const want = node.minArgs === node.maxArgs ? `${node.minArgs} 個` : `${node.minArgs}〜${node.maxArgs} 個`;
        this.fail('TypeError', `関数 ${fn.name || '(無名)'} は引数を ${want}受け取りますが、${args.length} 個渡されました`, n);
      }
      for (let i = 0; i < node.params.length; i++) {
        const p = node.params[i];
        scope.vars.set(p.name, i < args.length ? args[i] : this.ev(p.def, scope));
      }
      if (node.exprBody) return this.ev(node.body, scope);
      const r = this.execBlock(node.body, scope);
      return r instanceof ReturnSignal ? r.value : null;
    } catch (e) {
      if (e instanceof PreError && e.trace.length < 25) e.trace.push({ fn: fn.name || '(無名)', line: n ? n.line : this.line });
      throw e;
    } finally {
      this.depth--;
    }
  }
  evArgs(list, scope) {
    const out = new Array(list.length);
    for (let i = 0; i < list.length; i++) out[i] = this.ev(list[i], scope);
    return out;
  }

  /* ── 文 ── */
  hoist(b, scope) { for (const f of b.fns) scope.vars.set(f.name, new PreFn(f.name, f, scope)); }
  execBlock(b, scope) {
    if (b.fns) this.hoist(b, scope);
    const body = b.body;
    for (let i = 0; i < body.length; i++) { const r = this.exec(body[i], scope); if (r !== undefined) return r; }
    return undefined;
  }
  exec(n, scope) {
    this.line = n.line; this.col = n.col == null ? null : n.col;
    switch (n.t) {
      case 'Expr': this.ev(n.expr, scope); return undefined;
      case 'State': this.execState(n, scope); return undefined;
      case 'FnDecl': return undefined;
      case 'If': return this.execIf(n, scope);
      case 'While': return this.execWhile(n, scope);
      case 'For': return this.execFor(n, scope);
      case 'Return': return new ReturnSignal(n.arg ? this.ev(n.arg, scope) : null);
      case 'Break': return BREAK;
      case 'Show': this.show(this.ev(n.arg, scope), n); return undefined;
      default: return this.fail('InternalError', `未対応の文: ${n.t}`, n);
    }
  }
  execState(n, scope) {
    if (scope.vars.has(n.name)) this.fail('NameError', `'${n.name}' はすでに定義されています`, n);
    const st = this.ctx.state;
    const cur = st.get(n.name);
    // 初期値の式が書き換えられたときだけ、state は初期値に戻る
    if (!cur || cur.key !== n.initSrc) st.set(n.name, { value: this.ev(n.init, scope), key: n.initSrc });
    scope.vars.set(n.name, STATE);
  }
  execIf(n, scope) {
    if (truthy(this.ev(n.cond, scope))) return this.execBlock(n.then, scope);
    if (n.else) return n.else.t === 'If' ? this.exec(n.else, scope) : this.execBlock(n.else, scope);
    return undefined;
  }
  execWhile(n, scope) {
    while (truthy(this.ev(n.cond, scope))) {
      this.tick();
      const r = this.execBlock(n.body, scope);
      if (r !== undefined) { if (r === BREAK) break; return r; }
    }
    return undefined;
  }
  execFor(n, scope) {
    const items = this.toIterable(this.ev(n.iter, scope), n.iter);
    for (let i = 0; i < items.length; i++) {
      this.tick();
      this.bindLoop(n.names, items[i], scope, n, false);
      const r = this.execBlock(n.body, scope);
      if (r !== undefined) { if (r === BREAK) break; return r; }
    }
    return undefined;
  }
  toIterable(v, n) {
    if (Array.isArray(v)) return v;
    if (typeof v === 'string') return Array.from(v);
    if (v instanceof Map) return Array.from(v.keys());
    if (typeof v === 'number') this.fail('TypeError', '数値はくり返せません (範囲は 1..5 や 0..<5 と書きます)', n);
    return this.fail('TypeError', `${jp(v)}はくり返せません (リスト・文字・レコードが必要です)`, n);
  }
}

/* ---- core4b_eval.js ---- */
/* ============================================================
   Pre 2 — 式の評価 (Interpreter の続き)
   ============================================================ */
Object.assign(Interpreter.prototype, {
  ev(n, scope) {
    switch (n.t) {
      case 'Lit': return n.v;
      case 'Id': return this.lookup(n.name, scope, n);
      case 'Call': return this.evCall(n, scope);
      case 'Binary': return this.evBinary(n, scope);
      case 'Cond': return truthy(this.ev(n.test, scope)) ? this.ev(n.a, scope) : this.ev(n.b, scope);
      case 'Compare': return this.evCompare(n, scope);
      case 'Logical': {
        const l = this.ev(n.l, scope);
        return n.op === 'and' ? (truthy(l) ? this.ev(n.r, scope) : l) : (truthy(l) ? l : this.ev(n.r, scope));
      }
      case 'Member': return this.getMember(this.ev(n.obj, scope), n.prop, n);
      case 'Index': return this.getIndex(this.ev(n.obj, scope), this.ev(n.index, scope), n);
      case 'Slice': return this.evSlice(n, scope);
      case 'Assign': return this.evAssign(n, scope);
      case 'Tpl': {
        let s = '';
        for (const p of n.parts) s += typeof p === 'string' ? p : toStr(this.ev(p, scope));
        return s;
      }
      case 'Fmt': return formatValue(this.ev(n.expr, scope), n.spec, (m) => this.fail('ValueError', m, n));
      case 'List': return n.items.map((it) => this.ev(it, scope));
      case 'ListComp': return this.evComp(n, scope);
      case 'Record': {
        const m = new Map();
        for (const en of n.entries) m.set(en.key, this.ev(en.value, scope));
        return m;
      }
      case 'Fn': return new PreFn(n.name, n, scope);
      case 'Unary': return this.evUnary(n, scope);
      case 'Range': return this.evRange(n, scope);
      case 'Pipe': return this.evPipe(n, scope);
      case 'ShowRef': return this.fail('SyntaxError', 'show は `値 |> show` の形でだけ使えます', n);
      default: return this.fail('InternalError', `未対応の式: ${n.t}`, n);
    }
  },

  evCall(n, scope) {
    this.line = n.line; this.col = n.col;
    const f = this.ev(n.callee, scope);
    const args = this.evArgs(n.args, scope);
    this.line = n.line; this.col = n.col;
    return this.call(f, args, n);
  },
  evPipe(n, scope) {
    const v = this.ev(n.l, scope);
    const r = n.r;
    if (r.t === 'ShowRef') { this.line = n.line; this.col = n.col; this.show(v, n); return null; }
    if (r.t === 'Call') {
      const f = this.ev(r.callee, scope);
      const args = [v].concat(this.evArgs(r.args, scope));
      this.line = r.line; this.col = r.col;
      return this.call(f, args, r);
    }
    const f = this.ev(r, scope);
    this.line = n.line; this.col = n.col;
    return this.call(f, [v], n);
  },
  evUnary(n, scope) {
    const v = this.ev(n.arg, scope);
    if (n.op === 'not') return !truthy(v);
    if (typeof v !== 'number') this.fail('TypeError', `単項 '${n.op}' は数値にしか使えません (${jp(v)}が渡されました)`, n);
    return n.op === '-' ? -v : v;
  },
  evRange(n, scope) {
    const a = this.ev(n.l, scope), b = this.ev(n.r, scope);
    if (typeof a !== 'number' || typeof b !== 'number') this.fail('TypeError', `範囲 ${n.exclusive ? '..<' : '..'} の両端は数値にしてください (${jp(a)}と${jp(b)}が渡されました)`, n);
    const count = Math.max(0, n.exclusive ? Math.ceil(b - a) : Math.floor(b - a) + 1);
    if (!(count <= 1000000)) this.fail('ValueError', '範囲が大きすぎます (100 万個まで)', n);
    const out = new Array(count);
    for (let i = 0; i < count; i++) out[i] = a + i;
    return out;
  },
  evComp(n, scope) {
    const items = this.toIterable(this.ev(n.iter, scope), n.iter);
    const out = [];
    for (let i = 0; i < items.length; i++) {
      this.tick();
      const e = new Scope(scope);
      this.bindLoop(n.names, items[i], e, n, true);
      if (n.cond && !truthy(this.ev(n.cond, e))) continue;
      out.push(this.ev(n.elem, e));
    }
    return out;
  },
  evCompare(n, scope) {
    let left = this.ev(n.operands[0], scope);
    for (let k = 0; k < n.ops.length; k++) {
      const right = this.ev(n.operands[k + 1], scope);
      if (!this.cmpOp(n.ops[k], left, right, n)) return false;
      left = right;
    }
    return true;
  },
  evAssign(n, scope) {
    const t = n.target;
    const compound = n.op !== '=';
    const op = compound ? n.op.slice(0, -1) : null;
    let v;
    if (t.t === 'Id') {
      v = compound ? this.binop(op, this.lookup(t.name, scope, t), this.ev(n.value, scope), n) : this.ev(n.value, scope);
      if (v instanceof PreFn && !v.name) v.name = t.name;
      this.line = n.line; this.col = n.col;
      this.assignVar(t.name, v, scope, t);
      return v;
    }
    const o = this.ev(t.obj, scope);
    if (t.t === 'Member') {
      v = compound ? this.binop(op, this.getMember(o, t.prop, t), this.ev(n.value, scope), n) : this.ev(n.value, scope);
      this.setMember(o, t.prop, v, t);
      return v;
    }
    const i = this.ev(t.index, scope);
    v = compound ? this.binop(op, this.getIndex(o, i, t), this.ev(n.value, scope), n) : this.ev(n.value, scope);
    this.setIndex(o, i, v, t);
    return v;
  },

  /* ── 演算 ── */
  evBinary(n, scope) {
    const a = this.ev(n.l, scope), b = this.ev(n.r, scope);
    if (typeof a === 'number' && typeof b === 'number') {
      switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; default: break; }
    }
    return this.binop(n.op, a, b, n);
  },
  binop(op, a, b, n) {
    switch (op) {
      case '+':
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'string' || typeof b === 'string') return toStr(a) + toStr(b);
        if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
        break;
      case '-': if (typeof a === 'number' && typeof b === 'number') return a - b; break;
      case '*':
        if (typeof a === 'number' && typeof b === 'number') return a * b;
        if (typeof a === 'string' && typeof b === 'number') return this.repeat(a, b, n);
        if (typeof a === 'number' && typeof b === 'string') return this.repeat(b, a, n);
        if (Array.isArray(a) && typeof b === 'number') {
          if (!Number.isInteger(b) || b < 0 || a.length * b > 5000000) this.fail('ValueError', 'くり返す回数は 0 以上の整数にしてください (大きすぎないように)', n);
          const out = [];
          for (let i = 0; i < b; i++) for (let k = 0; k < a.length; k++) out.push(a[k]);
          return out;
        }
        break;
      case '/':
        if (typeof a === 'number' && typeof b === 'number') {
          if (b === 0) this.fail('ZeroDivisionError', '0 では割れません', n);
          return a / b;
        }
        break;
      case '%':
        if (typeof a === 'number' && typeof b === 'number') {
          if (b === 0) this.fail('ZeroDivisionError', '0 で割った余りは求められません', n);
          return ((a % b) + b) % b;
        }
        break;
      case '**': if (typeof a === 'number' && typeof b === 'number') return Math.pow(a, b); break;
      default: break;
    }
    return this.fail('TypeError', `演算子 '${op}' は${jp(a)}と${jp(b)}には使えません`, n);
  },
  repeat(s, k, n) {
    if (!Number.isInteger(k) || k < 0) this.fail('ValueError', 'くり返す回数は 0 以上の整数にしてください', n);
    if (s.length * k > 5000000) this.fail('ValueError', '文字列が大きすぎます', n);
    return s.repeat(k);
  },
  cmpOp(op, a, b, n) {
    switch (op) {
      case '==': return eq(a, b);
      case '!=': return !eq(a, b);
      case 'in': return this.contains(b, a, n);
      case 'not in': return !this.contains(b, a, n);
      default: break;
    }
    if (typeof a === 'number' && typeof b === 'number') {
      switch (op) { case '<': return a < b; case '>': return a > b; case '<=': return a <= b; default: return a >= b; }
    }
    const c = cmp(a, b, (m) => this.fail('TypeError', m, n));
    switch (op) { case '<': return c < 0; case '>': return c > 0; case '<=': return c <= 0; default: return c >= 0; }
  },
  contains(c, x, n) {
    if (Array.isArray(c)) { for (let i = 0; i < c.length; i++) if (eq(c[i], x)) return true; return false; }
    if (typeof c === 'string') {
      if (typeof x !== 'string') this.fail('TypeError', `文字の中を調べるには文字が必要です (${jp(x)}が渡されました)`, n);
      return c.indexOf(x) >= 0;
    }
    if (c instanceof Map) return c.has(x);
    return this.fail('TypeError', `${jp(c)}に対して 'in' は使えません (リスト・文字・レコードで使えます)`, n);
  },

  /* ── 添字・項目 ── */
  normIndex(len, i, n) {
    if (typeof i !== 'number' || !Number.isInteger(i)) this.fail('TypeError', `添字は整数である必要があります (${jp(i)}が渡されました)`, n);
    const k = i < 0 ? i + len : i;
    if (k < 0 || k >= len) this.fail('IndexError', `添字 ${i} は範囲外です (長さ ${len})`, n);
    return k;
  },
  getIndex(o, i, n) {
    if (Array.isArray(o)) return o[this.normIndex(o.length, i, n)];
    if (typeof o === 'string') return o[this.normIndex(o.length, i, n)];
    if (o instanceof Map) { const v = o.get(i); return v === undefined ? null : v; }
    if (o === null || o === undefined) this.fail('TypeError', 'null の要素は取り出せません', n);
    return this.fail('TypeError', `${jp(o)}には [ ] で要素を取り出せません`, n);
  },
  setIndex(o, i, v, n) {
    if (Array.isArray(o)) { o[this.normIndex(o.length, i, n)] = v; return; }
    if (o instanceof Map) { o.set(i, v); return; }
    if (typeof o === 'string') this.fail('TypeError', '文字の一部は書き換えられません (新しい文字を作ってください)', n);
    this.fail('TypeError', `${jp(o)}には [ ] で要素を代入できません`, n);
  },
  evSlice(n, scope) {
    const o = this.ev(n.obj, scope);
    const s = n.start ? this.ev(n.start, scope) : null, e = n.end ? this.ev(n.end, scope) : null;
    if (Array.isArray(o) || typeof o === 'string') { const [a, b] = this.sliceBounds(o.length, s, e, n); return o.slice(a, b); }
    return this.fail('TypeError', `${jp(o)}は [a:b] で切り出せません (リストと文字で使えます)`, n);
  },
  sliceBounds(len, s, e, n) {
    const chk = (x) => { if (typeof x !== 'number' || !Number.isInteger(x)) this.fail('TypeError', '切り出しの範囲は整数にしてください', n); };
    if (s === null) s = 0; else { chk(s); if (s < 0) s += len; }
    if (e === null) e = len; else { chk(e); if (e < 0) e += len; }
    return [Math.max(0, Math.min(len, s)), Math.max(0, Math.min(len, e))];
  },
  getMember(o, name, n) {
    if (o instanceof Map) { const v = o.get(name); return v === undefined ? null : v; }
    if (o === null || o === undefined) this.fail('TypeError', `null の '${name}' は参照できません (値がまだ決まっていません。if で確かめてください)`, n);
    return this.fail('TypeError', `${jp(o)}に '.${name}' はありません。Pre にメソッドはなく、関数で書きます${this.methodHint(name)}`, n);
  },
  methodHint(name) {
    if (METHOD_HINTS[name]) return METHOD_HINTS[name];
    if (this.builtins.has(name)) return `: ${name}(値, ...) または 値 |> ${name}(...) と書きます`;
    return '';
  },
  setMember(o, name, v, n) {
    if (o instanceof Map) { o.set(name, v); return; }
    if (o === null || o === undefined) this.fail('TypeError', `null の '${name}' には代入できません`, n);
    this.fail('TypeError', `${jp(o)}の '.${name}' には代入できません (項目を持てるのはレコードだけです)`, n);
  },
});

/* ---- core5_stdlib.js ---- */
/* ============================================================
   Pre 2 — 標準ライブラリ (約 50 個)。メソッドはなく、すべて関数。
   ============================================================ */
function makeBuiltins(I) {
  const B = new Map();
  const fail = (k, m) => I.fail(k, m);
  const def = (name, f) => { f.preName = name; B.set(name, f); };
  const num = (v, what) => { if (typeof v !== 'number') fail('TypeError', `${what} には数値が必要です (${jp(v)}が渡されました)`); return v; };
  const str = (v, what) => { if (typeof v !== 'string') fail('TypeError', `${what} には文字が必要です (${jp(v)}が渡されました)`); return v; };
  const lst = (v, what) => { if (!Array.isArray(v)) fail('TypeError', `${what} にはリストが必要です (${jp(v)}が渡されました)`); return v; };
  const isFn = (v) => v instanceof PreFn || typeof v === 'function';
  const fnc = (v, what) => { if (!isFn(v)) fail('TypeError', `${what} には関数が必要です (${jp(v)}が渡されました)`); return v; };
  const items = (v) => I.toIterable(v, null);
  const cb2 = (f, a, b) => (f instanceof PreFn ? I.callFn(f, [a, b].slice(0, f.node.maxArgs), null) : I.call(f, [a, b], null));
  const compare = (a, b) => cmp(a, b, (m) => fail('TypeError', m));

  /* 値: 時間とマウス (読んだ実行だけが、毎フレーム / マウスが動くたびに再実行される) */
  B.set('time', new Getter(() => { I.ctx.usedTime = true; return I.ctx.time; }));
  B.set('mouse', new Getter(() => {
    I.ctx.usedMouse = true;
    const m = I.ctx.mouse;
    return new Map([['x', m.x], ['y', m.y], ['down', !!m.down]]);
  }));
  B.set('pi', Math.PI);

  /* リストと文字 */
  def('len', (x) => {
    if (typeof x === 'string' || Array.isArray(x)) return x.length;
    if (x instanceof Map) return x.size;
    return fail('TypeError', `${jp(x)}には len() が使えません`);
  });
  def('map', (xs, f) => { fnc(f, 'map の関数'); const a = items(xs), out = []; for (let i = 0; i < a.length; i++) out.push(I.callCb(f, a[i], i)); return out; });
  def('filter', (xs, f) => { fnc(f, 'filter の関数'); const a = items(xs), out = []; for (let i = 0; i < a.length; i++) if (truthy(I.callCb(f, a[i], i))) out.push(a[i]); return out; });
  def('reduce', (xs, f, init) => {
    fnc(f, 'reduce の関数');
    const a = items(xs);
    let acc, i = 0;
    if (init === undefined) { if (!a.length) fail('TypeError', '空のリストは、初期値なしでは reduce できません'); acc = a[0]; i = 1; } else acc = init;
    for (; i < a.length; i++) acc = cb2(f, acc, a[i]);
    return acc;
  });
  def('find', (xs, f) => { fnc(f, 'find の関数'); const a = items(xs); for (let i = 0; i < a.length; i++) if (truthy(I.callCb(f, a[i], i))) return a[i]; return null; });
  def('sum', (xs) => { let s = 0; for (const x of lst(xs, 'sum')) s += num(x, 'sum の要素'); return s; });
  const pick = (name, sign) => (...a) => {
    const arr = a.length === 1 && (Array.isArray(a[0]) || typeof a[0] === 'string') ? items(a[0]) : a;
    if (!arr.length) fail('ValueError', `${name}() に渡す値がありません`);
    return arr.reduce((m, x) => (compare(x, m) * sign > 0 ? x : m));
  };
  def('min', pick('min', -1));
  def('max', pick('max', 1));
  def('sort', (xs, key) => {
    const a = items(xs).slice();
    if (key === undefined || key === null) return a.sort(compare);
    fnc(key, 'sort の並べ替えキー');
    const keyed = a.map((x, i) => [I.callCb(key, x, i), x]);
    keyed.sort((p, q) => compare(p[0], q[0]));
    return keyed.map((p) => p[1]);
  });
  def('reverse', (x) => (typeof x === 'string' ? Array.from(x).reverse().join('') : lst(x, 'reverse').slice().reverse()));
  def('zip', (...ls) => {
    const arrs = ls.map((l) => items(l));
    const m = arrs.length ? Math.min(...arrs.map((a) => a.length)) : 0;
    const out = [];
    for (let i = 0; i < m; i++) out.push(arrs.map((a) => a[i]));
    return out;
  });
  def('enumerate', (xs, start) => { const s = start === undefined ? 0 : num(start, 'enumerate の開始番号'); return items(xs).map((v, i) => [i + s, v]); });
  def('push', (xs, ...vs) => { lst(xs, 'push の対象'); for (const v of vs) xs.push(v); return null; });
  def('pop', (xs) => { lst(xs, 'pop の対象'); if (!xs.length) fail('IndexError', '空のリストから pop できません'); return xs.pop(); });

  /* 文字 */
  def('upper', (s) => str(s, 'upper').toUpperCase());
  def('lower', (s) => str(s, 'lower').toLowerCase());
  def('trim', (s) => str(s, 'trim').trim());
  def('split', (s, sep) => {
    str(s, 'split');
    if (sep === undefined || sep === null) return s.split(/\s+/).filter((x) => x !== '');
    return str(sep, 'split の区切り') === '' ? Array.from(s) : s.split(sep);
  });
  def('join', (xs, sep) => items(xs).map((x) => toStr(x)).join(sep === undefined ? ', ' : str(sep, 'join の区切り')));
  def('replace', (s, a, b) => str(s, 'replace').split(str(a, 'replace の検索文字')).join(str(b, 'replace の置換文字')));
  def('num', (x) => {
    if (typeof x === 'number') return x;
    if (typeof x === 'boolean') return x ? 1 : 0;
    if (typeof x === 'string') {
      const t = x.trim();
      const v = t === '' ? NaN : Number(t);
      if (Number.isNaN(v)) fail('ValueError', `${JSON.stringify(x)} は数値に変換できません`);
      return v;
    }
    return fail('ValueError', `${jp(x)}は数値に変換できません`);
  });

  /* 数学 */
  def('abs', (x) => Math.abs(num(x, 'abs')));
  def('floor', (x) => Math.floor(num(x, 'floor')));
  def('ceil', (x) => Math.ceil(num(x, 'ceil')));
  def('round', (x, d) => {
    num(x, 'round');
    const f = Math.pow(10, d === undefined ? 0 : num(d, 'round の桁数'));
    const a = Math.abs(x);
    return Math.sign(x) * Math.round((a + a * Number.EPSILON) * f) / f;
  });
  def('sqrt', (x) => { num(x, 'sqrt'); if (x < 0) fail('ValueError', '負の数の平方根は求められません'); return Math.sqrt(x); });
  def('sin', (x) => Math.sin(num(x, 'sin')));
  def('cos', (x) => Math.cos(num(x, 'cos')));
  def('atan2', (y, x) => Math.atan2(num(y, 'atan2'), num(x, 'atan2')));
  def('clamp', (x, lo, hi) => Math.min(Math.max(num(x, 'clamp'), num(lo, 'clamp の下限')), num(hi, 'clamp の上限')));
  def('random', () => Math.random());
  def('randint', (a, b) => { num(a, 'randint'); num(b, 'randint'); return Math.floor(Math.random() * (Math.floor(b) - Math.ceil(a) + 1)) + Math.ceil(a); });

  /* レコード・その他 */
  def('keys', (r) => (r instanceof Map ? Array.from(r.keys()) : fail('TypeError', `${jp(r)}には keys() が使えません (レコードで使います)`)));
  def('values', (r) => (r instanceof Map ? Array.from(r.values()) : fail('TypeError', `${jp(r)}には values() が使えません (レコードで使います)`)));
  def('pairs', (r) => (r instanceof Map ? Array.from(r.entries()).map(([k, v]) => [k, v]) : fail('TypeError', `${jp(r)}には pairs() が使えません (レコードで使います)`)));
  def('type', (x) => typeName(x));
  def('fail', (msg) => fail('Error', msg === undefined ? '止まりました' : toStr(msg)));

  /* 色と図形 (図形は kind を持つただのレコード) */
  const col = (c, d) => {
    if (c === undefined || c === null) return d;
    if (typeof c !== 'string') fail('TypeError', `色には文字が必要です (例: "tomato" や hsl(200, 70, 50))。${jp(c)}が渡されました`);
    return c;
  };
  const shape = (kind, fields) => new Map([['kind', kind], ...Object.entries(fields)]);
  def('hsl', (h, s, l) => `hsl(${num(h, 'hsl の色相')}, ${s === undefined ? 70 : num(s, 'hsl の彩度')}%, ${l === undefined ? 55 : num(l, 'hsl の明るさ')}%)`);
  def('rgb', (r, g, b) => `rgb(${Math.round(num(r, 'rgb の r'))}, ${Math.round(num(g, 'rgb の g'))}, ${Math.round(num(b, 'rgb の b'))})`);
  def('circle', (x, y, r, c) => shape('circle', { x: num(x, 'circle の x'), y: num(y, 'circle の y'), r: num(r, 'circle の半径'), color: col(c, '#222'), fill: true, width: 2 }));
  def('rect', (x, y, w, h, c) => shape('rect', { x: num(x, 'rect の x'), y: num(y, 'rect の y'), w: num(w, 'rect の幅'), h: num(h, 'rect の高さ'), color: col(c, '#222'), fill: true, width: 2 }));
  def('line', (x1, y1, x2, y2, c, w) => shape('line', { x1: num(x1, 'line の x1'), y1: num(y1, 'line の y1'), x2: num(x2, 'line の x2'), y2: num(y2, 'line の y2'), color: col(c, '#222'), width: w === undefined ? 2 : num(w, 'line の太さ') }));
  def('label', (text, x, y, c, size) => shape('label', { text: toStr(text), x: num(x, 'label の x'), y: num(y, 'label の y'), color: col(c, '#222'), size: size === undefined ? 16 : num(size, 'label の文字サイズ') }));
  def('outline', (s, w) => {
    if (!isShape(s)) fail('TypeError', `outline には図形が必要です (${jp(s)}が渡されました)`);
    const c = new Map(s);
    c.set('fill', false);
    c.set('width', w === undefined ? 2 : num(w, 'outline の太さ'));
    return c;
  });
  def('canvas', (w, h, bg) => {
    const cv = I.ctx.canvasItem();
    cv.w = Math.max(1, Math.min(2000, num(w, 'canvas の幅')));
    cv.h = Math.max(1, Math.min(2000, num(h, 'canvas の高さ')));
    if (bg !== undefined) cv.bg = col(bg, cv.bg);
    return null;
  });

  /* ウィジェット: 呼んだ場所に部品を出し、そのときの値を返す */
  def('slider', (label, min, max, init, step) => {
    str(label, 'slider のラベル'); num(min, 'slider の最小値'); num(max, 'slider の最大値');
    if (max < min) fail('ValueError', 'slider の最小値が最大値より大きくなっています');
    const v0 = init === undefined || init === null ? min : num(init, 'slider の初期値');
    const st = step === undefined ? (Number.isInteger(min) && Number.isInteger(max) && Number.isInteger(v0) ? 1 : (max - min) / 100 || 1) : num(step, 'slider の刻み');
    return I.ctx.widget('slider', label, { min, max, step: st }, v0);
  });
  def('choice', (label, options, init) => {
    str(label, 'choice のラベル'); lst(options, 'choice の選択肢');
    if (!options.length) fail('ValueError', 'choice の選択肢が空です');
    const v0 = init !== undefined && options.some((o) => eq(o, init)) ? init : options[0];
    return I.ctx.widget('choice', label, { options: options.slice() }, v0);
  });
  def('toggle', (label, init) => I.ctx.widget('toggle', str(label, 'toggle のラベル'), {}, init === undefined ? false : truthy(init)));
  def('textbox', (label, init) => I.ctx.widget('textbox', str(label, 'textbox のラベル'), {}, init === undefined || init === null ? '' : toStr(init)));
  def('button', (label) => I.ctx.widget('button', str(label, 'button のラベル'), {}, false));
  def('reset', (label) => { I.ctx.resetWidget(str(label, 'reset のラベル')); return null; });

  /* show: 文字は行、レコードのリストは表、図形 (のリスト) は 1 枚の絵になる */
  const collect = (v, out, depth) => {
    if (isShape(v)) { out.push(v); return true; }
    // 入れ子の空リストは「何も描かない」。いちばん外側の空リストだけは、図形かどうか分からないので対象外
    if (Array.isArray(v) && (v.length || depth > 0) && depth < 4) { for (const x of v) if (!collect(x, out, depth + 1)) return false; return true; }
    return false;
  };
  const hasShape = (v, depth) => isShape(v) || (Array.isArray(v) && depth < 4 && v.some((x) => hasShape(x, depth + 1)));
  // 最初に見つかった「図形ではない葉」を { v } で返す (なければ null)
  const findBad = (v, depth) => {
    if (isShape(v)) return null;
    if (Array.isArray(v) && depth < 4) { for (const x of v) { const b = findBad(x, depth + 1); if (b) return b; } return null; }
    return { v };
  };
  const shapeOp = (m) => {
    const g = (k) => m.get(k);
    const chk = (k, what) => { const v = g(k); if (typeof v !== 'number' || v !== v) fail('TypeError', `図形の ${what} が数値ではありません (${jp(v)})`); return v; };
    switch (g('kind')) {
      case 'circle': return ['c', chk('x', 'x'), chk('y', 'y'), chk('r', '半径 r'), toStr(g('color')), g('fill') !== false, +g('width') || 2];
      case 'rect': return ['r', chk('x', 'x'), chk('y', 'y'), chk('w', '幅 w'), chk('h', '高さ h'), toStr(g('color')), g('fill') !== false, +g('width') || 2];
      case 'line': return ['l', chk('x1', 'x1'), chk('y1', 'y1'), chk('x2', 'x2'), chk('y2', 'y2'), toStr(g('color')), +g('width') || 2];
      default: return ['t', toStr(g('text')), chk('x', 'x'), chk('y', 'y'), toStr(g('color')), +g('size') || 16];
    }
  };
  I.show = (v) => {
    const ctx = I.ctx;
    const leaves = [];
    if (collect(v, leaves, 0)) {
      const cv = ctx.canvasItem();
      if (cv.shapes.length + leaves.length > ctx.limits.shapes) fail('LimitError', `図形が多すぎます (1 回の実行で ${ctx.limits.shapes} 個まで)`);
      for (const m of leaves) cv.shapes.push(shapeOp(m));
      return;
    }
    // 図形に図形でない値が混ざっているとき。黙って文字にせず、原因を教える
    if (Array.isArray(v) && hasShape(v, 0)) {
      const bad = findBad(v, 0);
      if (bad) {
        const hint = bad.v === null ? ' (canvas(...) を show の中に入れていませんか？ canvas は show の外で、1 行だけで呼びます)' : '';
        fail('TypeError', `図形のリストに、図形ではない値 (${bad.v === null ? 'null' : jp(bad.v) + ': ' + toStr(bad.v).slice(0, 30)}) が混ざっています${hint}`);
      }
    }
    if (Array.isArray(v) && v.length && v.every((x) => x instanceof Map && !isShape(x))) {
      const cols = [];
      for (const r of v) for (const k of r.keys()) if (!cols.includes(k)) cols.push(k);
      const shown = v.slice(0, 1000);
      const rows = shown.map((r) => cols.map((k) => (r.has(k) ? toStr(r.get(k)) : '')));
      const isNum = cols.map((k) => shown.every((r) => !r.has(k) || typeof r.get(k) === 'number'));
      ctx.addItem({ t: 'table', cols: cols.map((k, i) => ({ name: toStr(k), num: isNum[i] })), rows, more: v.length - shown.length });
      return;
    }
    ctx.addItem({ t: 'text', s: toStr(v) });
  };
  return B;
}

/* ---- core6_session.js ---- */
/* ============================================================
   Pre 2 — 再実行モデル (Session) と公開 API
   Session が覚えているのは state とウィジェットの値だけ。
   frame() のたびに、プログラムを上から新しく実行して、画面の部品(items)を作り直す。
   ============================================================ */
class Ctx {
  constructor(session, ev) {
    this.session = session;
    this.state = session.state;
    this.items = [];
    this.canvas = null;
    this.time = typeof ev.time === 'number' ? ev.time : 0;
    this.mouse = ev.mouse || { x: 0, y: 0, down: false };
    this.clicked = ev.clicked == null ? null : ev.clicked;
    this.usedTime = false;
    this.usedMouse = false;
    this.seen = new Set();
    this.timeLimit = session.timeLimit;
    this.limits = { shapes: 50000, items: 3000, chars: 1000000 };
    this.chars = 0;
    this.I = null;
  }
  getState(name) { return this.state.get(name).value; }
  setState(name, v) { this.state.get(name).value = v; }
  addItem(it) {
    if (this.items.length >= this.limits.items) this.I.fail('LimitError', `出力が多すぎます (1 回の実行で ${this.limits.items} 個まで)`);
    if (it.t === 'text') {
      this.chars += it.s.length;
      if (this.chars > this.limits.chars) this.I.fail('LimitError', '出力する文字が多すぎます');
    }
    this.items.push(it);
  }
  canvasItem() {
    if (!this.canvas) { this.canvas = { t: 'canvas', w: 480, h: 320, bg: '#fbfbf8', shapes: [] }; this.addItem(this.canvas); }
    return this.canvas;
  }
  widget(kind, label, cfg, init) {
    if (this.seen.has(label)) this.I.fail('ValueError', `同じラベル "${label}" の部品が 2 つあります。ラベルを変えてください`);
    this.seen.add(label);
    const reg = this.session.widgets;
    const initKey = JSON.stringify([kind, init, cfg.options || null]);
    let w = reg.get(label);
    // 初期値の指定が書き換えられたときだけ、部品は初期値に戻る
    if (!w || w.kind !== kind || w.initKey !== initKey) { w = { kind, value: init, initKey, init, options: null }; reg.set(label, w); }
    if (kind === 'slider') w.value = Math.min(Math.max(w.value, cfg.min), cfg.max);
    if (kind === 'choice') { w.options = cfg.options; if (!cfg.options.some((o) => eq(o, w.value))) w.value = init; }
    const item = Object.assign({ t: 'w', kind, label, value: kind === 'button' ? false : w.value }, cfg);
    if (kind === 'choice') {
      // 画面には文字の選択肢と「何番目か」だけを渡す (値そのものは Session が覚えている)
      item.index = cfg.options.findIndex((o) => eq(o, w.value));
      item.options = cfg.options.map((o) => toStr(o));
      item.value = toStr(w.value);
    }
    this.addItem(item);
    return kind === 'button' ? this.clicked === label : w.value;
  }
  resetWidget(label) {
    const w = this.session.widgets.get(label);
    if (!w) this.I.fail('ValueError', `reset: "${label}" という部品はありません (ラベルを確かめてください)`);
    w.value = w.init;
  }
}

function describeError(e, I) {
  if (e instanceof PreError) return { kind: e.kind, message: e.message, line: e.line, col: e.col, trace: e.trace };
  if (e instanceof RangeError && /call stack/i.test(e.message)) {
    return { kind: 'RecursionError', message: '再帰が深すぎます。終わりの条件を確認してください', line: I ? I.line : null, col: null, trace: [] };
  }
  return { kind: 'InternalError', message: String((e && e.message) || e), line: I ? I.line : null, col: null, trace: [], stack: e && e.stack };
}

class Session {
  constructor(opts) {
    opts = opts || {};
    this.timeLimit = opts.timeLimit || 2000;
    this.state = new Map();   // name -> { value, key }
    this.widgets = new Map(); // label -> { kind, value, initKey, options }
    this.ast = null;
    this.code = '';
  }
  // コードを読み込む。文法エラーのときは、前に読み込んだプログラムをそのまま残す
  load(code) {
    try {
      this.ast = parse(String(code));
      this.code = String(code);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: describeError(e, null) };
    }
  }
  reset() { this.state.clear(); this.widgets.clear(); }
  applyInput(input) {
    const w = this.widgets.get(input.label);
    if (!w) return;
    switch (w.kind) {
      case 'slider': if (typeof input.value === 'number') w.value = input.value; break;
      case 'toggle': w.value = !!input.value; break;
      case 'textbox': w.value = String(input.value); break;
      case 'choice': if (w.options && w.options[input.value] !== undefined) w.value = w.options[input.value]; break;
      default: break;
    }
  }
  // 状態と部品の値を、文字にして控える (実行の前後で変わったかを調べるため)
  signature() {
    let s = '';
    for (const [k, v] of this.state) s += k + '=' + repr(v.value, 0, []) + ';';
    for (const [k, w] of this.widgets) s += '@' + k + '=' + repr(w.value, 0, []) + ';';
    return s;
  }
  // ev = { time, mouse: {x, y, down}, clicked: ラベル, input: {label, value} }
  // ボタンや入力の直後は、実行して state が変わっていたら、もう一度だけ実行し直す。
  // だから show を if button(...) の上に書いても、押した結果がすぐ画面に出る。
  frame(ev) {
    ev = ev || {};
    if (!this.ast) return { ok: false, error: { kind: 'Error', message: 'プログラムがありません', line: null, col: null, trace: [] }, items: [] };
    if (ev.input) this.applyInput(ev.input);
    const settle = ev.clicked != null || !!ev.input;
    const before = settle ? this.signature() : null;
    let r = this.runOnce(ev);
    if (settle && r.ok && this.signature() !== before) {
      const r2 = this.runOnce({ time: ev.time, mouse: ev.mouse });
      r2.settled = true;
      r2.ms += r.ms;
      r = r2;
    }
    return r;
  }
  runOnce(ev) {
    const ctx = new Ctx(this, ev);
    const I = new Interpreter(ctx);
    const t0 = nowMs();
    try {
      I.run(this.ast);
    } catch (e) {
      return { ok: false, error: describeError(e, I), items: ctx.items, ms: nowMs() - t0 };
    }
    return { ok: true, items: ctx.items, animating: ctx.usedTime, wantsMouse: ctx.usedMouse, ms: nowMs() - t0 };
  }
}

// 画面の部品 (items) を、確認用の文字にする (テストや Node での実行用)
function toText(items) {
  const lines = [];
  for (const it of items) {
    switch (it.t) {
      case 'text': lines.push(it.s); break;
      case 'table': lines.push(it.cols.map((c) => c.name).join(' | ')); for (const r of it.rows) lines.push(r.join(' | ')); break;
      case 'canvas': lines.push(`[canvas ${it.w}x${it.h}: 図形 ${it.shapes.length} 個]`); break;
      case 'w': lines.push(`[${it.kind} ${it.label}${it.kind === 'button' ? '' : ' = ' + toStr(it.value)}]`); break;
      default: break;
    }
  }
  return lines.join('\n') + (lines.length ? '\n' : '');
}

// 1 回だけ実行する (Node やテスト向け)
function run(code, ev, opts) {
  const s = new Session(opts);
  const l = s.load(code);
  if (!l.ok) return { ok: false, error: l.error, items: [], session: s };
  const r = s.frame(ev);
  r.session = s;
  return r;
}

let nameCache = null;
function builtinNames() {
  if (!nameCache) { const I = new Interpreter(new Ctx(new Session(), {})); nameCache = Array.from(I.builtins.keys()); }
  return nameCache;
}

return {
  version: '2.0.0',
  Session,
  run,
  parse,
  lex,
  toText,
  toStr,
  builtinNames,
  keywords: Array.from(KEYWORDS),
};

});
