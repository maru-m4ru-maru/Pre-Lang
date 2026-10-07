/* Pre — ブラウザの中だけで動く、読みやすい小さなプログラミング言語。
 * 字句解析 → 構文解析 → ツリーウォーク型インタープリタ。eval / new Function は使いません。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Pre = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VERSION = '1.1.1';
  const MAX_DEPTH = 1000;

  /* ═════════════ 値とエラー ═════════════ */
  class PreError {
    constructor(kind, message, line, col) {
      this.kind = kind; this.message = message;
      this.line = line == null ? null : line; this.col = col == null ? null : col;
      this.trace = []; this.fatal = false;
    }
  }
  class PreThrow {
    constructor(value, line) { this.value = value; this.line = line == null ? null : line; this.trace = []; this.fatal = false; }
  }
  class ReturnSignal { constructor(value) { this.value = value; } }
  const BREAK = { sig: 'break' };
  const CONTINUE = { sig: 'continue' };
  const SHORT = { short: true };

  class PreFunction {
    constructor(name, params, body, env, exprBody, retType, minArgs, maxArgs) {
      this.name = name; this.params = params; this.body = body; this.env = env;
      this.exprBody = exprBody; this.retType = retType; this.minArgs = minArgs; this.maxArgs = maxArgs;
      this.home = null;
    }
  }
  class BoundMethod { constructor(fn, self) { this.fn = fn; this.self = self; } }
  class PreClass {
    constructor(name, parent, env) { this.name = name; this.parent = parent; this.env = env; this.methods = new Map(); this.fields = []; }
    findMethod(name) { for (let c = this; c; c = c.parent) { const m = c.methods.get(name); if (m) return m; } return null; }
    isSub(other) { for (let c = this; c; c = c.parent) if (c === other) return true; return false; }
  }
  class PreInstance { constructor(cls) { this.cls = cls; this.props = new Map(); } }

  class Env {
    constructor(parent) { this.vars = new Map(); this.parent = parent || null; this.consts = null; this.home = null; }
    define(name, v, isConst) {
      this.vars.set(name, v === undefined ? null : v);
      if (isConst) { if (!this.consts) this.consts = new Set(); this.consts.add(name); }
      else if (this.consts) this.consts.delete(name);
    }
  }

  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

  function lev(a, b) {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    let prev = Array.from({ length: n + 1 }, (_, i) => i);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function closest(name, cands) {
    let best = null, bd = 99;
    const lname = name.toLowerCase();
    for (const c of cands) { const d = lev(lname, c.toLowerCase()); if (d < bd) { bd = d; best = c; } }
    if (name.length < 3) return null;
    return best && best !== name && bd <= Math.max(1, Math.floor(name.length / 3)) ? best : null;
  }

  /* ═════════════ 字句解析 ═════════════ */
  const KEYWORDS = new Set(['let', 'const', 'fn', 'return', 'if', 'else', 'elif', 'while', 'for', 'in', 'break', 'continue',
    'class', 'extends', 'new', 'this', 'super', 'try', 'catch', 'finally', 'throw', 'true', 'false', 'null', 'and', 'or', 'not', 'match']);
  const KW_ALIAS = { def: 'fn', function: 'fn' };
  const IDENT_RE = /[\p{L}_$][\p{L}\p{N}_$]*/uy;
  const NUM_RE = /0[xX][0-9a-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?/y;
  const OPS3 = new Set(['===', '!==', '...']);
  const OPS2 = new Set(['**', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '=>', '+=', '-=', '*=', '/=', '%=', '++', '--', '<<', '>>', '|>']);
  const OPS1 = '+-*/%=<>!?:,.;()[]{}&|^~';
  const CLOSERS = { ')': '(', ']': '[', '}': '{' };

  // f"{値:書式}" の「:書式」を切り出す (三項演算子の ':' や括弧の中の ':' は書式とみなさない)
  function splitFormatSpec(s) {
    let depth = 0, tern = false;
    for (let k = 0; k < s.length; k++) {
      const ch = s[k];
      if (ch === '"' || ch === "'" || ch === '`') {
        k++;
        while (k < s.length && s[k] !== ch) { if (s[k] === '\\') k++; k++; }
        continue;
      }
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth--;
      else if (depth === 0) {
        if (ch === '?' && s[k + 1] !== '.' && s[k + 1] !== '?' && s[k - 1] !== '?') tern = true;
        else if (ch === ':' && !tern) return { expr: s.slice(0, k), spec: s.slice(k + 1) };
      }
    }
    return { expr: s, spec: null };
  }

  function tokenize(src, baseLine) {
    const toks = [];
    const n = src.length;
    let i = 0, line = baseLine || 1, ls = 0;
    const stack = [];
    const fail = (msg, l, c) => { throw new PreError('SyntaxError', msg, l, c); };
    const add = (t, v, l, c, extra) => {
      const tk = { t, v, line: l, col: c };
      if (extra) for (const k in extra) tk[k] = extra[k];
      toks.push(tk);
    };
    const pushNl = (l, c) => { const last = toks[toks.length - 1]; if (last && last.t !== 'nl') add('nl', '\n', l, c); };

    // 次の行が式の続き（.foo や && など）かどうか
    const continues = (j) => {
      while (j < n) {
        const c = src[j];
        if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { j++; continue; }
        if (c === '#' || (c === '/' && src[j + 1] === '/')) { while (j < n && src[j] !== '\n') j++; continue; }
        if (c === '/' && src[j + 1] === '*') { const e = src.indexOf('*/', j + 2); j = e < 0 ? n : e + 2; continue; }
        break;
      }
      if (j >= n) return false;
      const c = src[j], d = src[j + 1];
      if (c === '.' && d !== '.' && !(d >= '0' && d <= '9')) return true;
      if (c === '?' || c === ':') return true;
      if ((c === '&' && d === '&') || (c === '|' && (d === '|' || d === '>'))) return true;
      return false;
    };

    const skipQuoted = (j) => {
      const q = src[j]; j++;
      while (j < n && src[j] !== q) { if (src[j] === '\\') j++; j++; }
      return j + 1;
    };
    const scanBalanced = (j, sl, sc) => {
      let depth = 1;
      while (j < n) {
        const c = src[j];
        if (c === '"' || c === "'" || c === '`') { j = skipQuoted(j); continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) return j; }
        j++;
      }
      fail('文字列の中の { が閉じられていません', sl, sc);
    };
    const readEscape = () => {
      const e = src[i++];
      switch (e) {
        case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r'; case '0': return '\0';
        case 'b': return '\b'; case 'f': return '\f'; case 'v': return '\v';
        case 'x': { const h = src.substr(i, 2); i += 2; return String.fromCharCode(parseInt(h, 16)); }
        case 'u': {
          if (src[i] === '{') { const e2 = src.indexOf('}', i); const h = src.slice(i + 1, e2); i = e2 + 1; return String.fromCodePoint(parseInt(h, 16)); }
          const h = src.substr(i, 4); i += 4; return String.fromCharCode(parseInt(h, 16));
        }
        default: return e === undefined ? '' : e;
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
      if (c === '#' || (c === '/' && src[i + 1] === '/')) { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        if (e < 0) fail('コメントが閉じられていません', line, col);
        for (let k = i; k < e; k++) if (src[k] === '\n') { line++; ls = k + 1; }
        i = e + 2; continue;
      }

      // 文字列 / テンプレート / f文字列
      if (c === '"' || c === "'" || c === '`' || (c === 'f' && (src[i + 1] === '"' || src[i + 1] === "'"))) {
        let mode = 'plain', q = c;
        const sl = line;
        if (c === '`') mode = 'tpl';
        else if (c === 'f') { mode = 'f'; i++; q = src[i]; }
        i++;
        let triple = false;
        if (mode !== 'tpl' && src[i] === q && src[i + 1] === q) { triple = true; i += 2; }
        let cur = '';
        const parts = [];
        let hasExpr = false;
        for (;;) {
          if (i >= n) fail('文字列が閉じられていません', sl, col);
          const ch = src[i];
          if (triple ? (ch === q && src[i + 1] === q && src[i + 2] === q) : ch === q) { i += triple ? 3 : 1; break; }
          if (ch === '\n') {
            if (mode === 'plain' && !triple) fail('文字列が閉じられていません (複数行にしたいときは """ か ` を使います)', sl, col);
            line++; ls = i + 1; cur += ch; i++; continue;
          }
          if (ch === '\\') { i++; cur += readEscape(); continue; }
          let exprStart = -1;
          if (mode === 'tpl' && ch === '$' && src[i + 1] === '{') exprStart = i + 2;
          else if (mode === 'f') {
            if (ch === '{') { if (src[i + 1] === '{') { cur += '{'; i += 2; continue; } exprStart = i + 1; }
            else if (ch === '}') { if (src[i + 1] === '}') { cur += '}'; i += 2; continue; } fail("f文字列の中の '}' は '}}' と書いてください", line, i - ls + 1); }
          }
          if (exprStart >= 0) {
            const end = scanBalanced(exprStart, line, i - ls + 1);
            const exprSrc = src.slice(exprStart, end);
            parts.push(cur); cur = '';
            if (mode === 'f') { const sp = splitFormatSpec(exprSrc); parts.push({ src: sp.expr, line, spec: sp.spec }); }
            else parts.push({ src: exprSrc, line });
            hasExpr = true;
            for (let k = 0; k < exprSrc.length; k++) if (exprSrc[k] === '\n') { line++; ls = exprStart + k + 1; }
            i = end + 1;
            continue;
          }
          cur += ch; i++;
        }
        if (hasExpr) { if (cur) parts.push(cur); add('tpl', parts.filter((p) => p !== ''), sl, col); }
        else add('str', cur, sl, col);
        continue;
      }

      if (c >= '0' && c <= '9') {
        NUM_RE.lastIndex = i;
        const m = NUM_RE.exec(src);
        const text = m[0].replace(/_/g, '');
        i += m[0].length;
        if (i < n && /[\p{L}_$]/u.test(src[i])) fail('数値の直後に文字を続けることはできません', line, col);
        add('num', Number(text), line, col);
        continue;
      }

      IDENT_RE.lastIndex = i;
      const im = IDENT_RE.exec(src);
      if (im) {
        const word = im[0];
        i += word.length;
        const kw = KW_ALIAS[word] || word;
        if (KEYWORDS.has(kw)) add('kw', kw, line, col);
        else add('id', word, line, col);
        continue;
      }

      let op = null;
      const s3 = src.substr(i, 3), s2 = src.substr(i, 2);
      if (OPS3.has(s3)) op = s3;
      else if (OPS2.has(s2) && !(s2 === '?.' && /[0-9]/.test(src[i + 2] || ''))) op = s2;
      else if (OPS1.indexOf(c) >= 0) op = c;
      else fail(`使えない文字 '${c}' があります`, line, col);
      if (op === '(' || op === '[' || op === '{') stack.push({ ch: op, line, col });
      else if (op === ')' || op === ']' || op === '}') {
        const top = stack.pop();
        if (!top || top.ch !== CLOSERS[op]) fail(`対応する開き括弧のない '${op}' があります`, line, col);
      }
      i += op.length;
      add('op', op, line, col);
    }
    if (stack.length) { const o = stack[stack.length - 1]; fail(`'${o.ch}' が閉じられていません`, o.line, o.col); }
    pushNl(line, i - ls + 1);
    add('eof', '', line, i - ls + 1);
    return toks;
  }

  /* ═════════════ 構文解析 ═════════════ */
  const BIN_PREC = { '??': 1, '||': 2, '&&': 3, '|': 6, '^': 7, '&': 8, '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11 };
  const CMP_OPS = new Set(['==', '!=', '===', '!==', '<', '>', '<=', '>=']);
  const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=']);

  class Parser {
    constructor(toks) { this.toks = toks; this.p = 0; }
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
    expectOp(v, what) {
      if (!this.eatOp(v)) this.fail(`${what || "'" + v + "'"} が必要ですが、${this.desc(this.tok)} が見つかりました`);
    }
    skipNl() { while (this.tok.t === 'nl') this.p++; }
    skipTerms() { while (this.tok.t === 'nl' || this.isOp(';')) this.p++; }
    endStmt() {
      const t = this.tok;
      if (t.t === 'nl' || t.t === 'eof' || (t.t === 'op' && (t.v === ';' || t.v === '}'))) return;
      this.fail(`${this.desc(t)} は予期しない位置にあります (文は改行か ; で区切ります)`);
    }
    mkBlock(body, tok) {
      const fns = body.filter((s) => s.t === 'FnDecl');
      const needsScope = body.some((s) => s.t === 'Let' || s.t === 'Seq' || s.t === 'FnDecl' || s.t === 'ClassDecl');
      return { t: 'Block', body, fns: fns.length ? fns : null, needsScope, line: tok.line };
    }

    parseProgram() {
      const first = this.tok;
      const body = [];
      this.skipTerms();
      while (this.tok.t !== 'eof') { body.push(this.parseStatement()); this.skipTerms(); }
      return this.mkBlock(body, first);
    }
    parseBlock() {
      const open = this.tok;
      this.expectOp('{');
      const body = [];
      this.skipTerms();
      while (!this.isOp('}')) {
        if (this.tok.t === 'eof') this.fail("'}' が見つかりません (ブロックが閉じられていません)", open);
        body.push(this.parseStatement());
        this.skipTerms();
      }
      this.next();
      return this.mkBlock(body, open);
    }

    parseStatement() {
      const t = this.tok;
      if (t.t === 'kw') {
        switch (t.v) {
          case 'let': case 'const': { const s = this.parseLet(); this.endStmt(); return s; }
          case 'fn':
            if (this.peekTok().t === 'id') {
              this.next();
              const name = this.next().v;
              const f = this.parseFunction(name, t);
              f.t = 'FnDecl';
              if (f.exprBody) this.endStmt();
              return f;
            }
            break;
          case 'class': return this.parseClass();
          case 'if': return this.parseIf();
          case 'while': { this.next(); const cond = this.parseExpr(); const body = this.parseBlock(); return { t: 'While', cond, body, line: t.line, col: t.col }; }
          case 'for': return this.parseFor();
          case 'return': {
            this.next();
            let arg = null;
            const k = this.tok;
            if (!(k.t === 'nl' || k.t === 'eof' || (k.t === 'op' && (k.v === ';' || k.v === '}')))) arg = this.parseExpr();
            this.endStmt();
            return { t: 'Return', arg, line: t.line, col: t.col };
          }
          case 'break': this.next(); this.endStmt(); return { t: 'Break', line: t.line };
          case 'continue': this.next(); this.endStmt(); return { t: 'Continue', line: t.line };
          case 'throw': { this.next(); const arg = this.parseExpr(); this.endStmt(); return { t: 'Throw', arg, line: t.line, col: t.col }; }
          case 'try': return this.parseTry();
          case 'match': { const m = this.parseMatch(); m.stmt = true; return m; }
          default: break;
        }
      }
      if (t.t === 'op' && t.v === '{') return this.parseBlock();
      const expr = this.parseExpr();
      this.endStmt();
      return { t: 'Expr', expr, line: t.line, col: t.col };
    }

    parseLet() {
      const kwTok = this.next();
      const kind = kwTok.v;
      const decls = [];
      for (;;) {
        const target = this.parsePattern();
        let type = null, init = null;
        if (this.eatOp(':')) type = this.parseType();
        if (this.eatOp('=')) { this.skipNl(); init = this.parseExpr(); }
        else if (kind === 'const') this.fail('const には初期値が必要です (const x = 1 のように書きます)');
        else if (target.t !== 'PId') this.fail('分割代入には初期値が必要です');
        decls.push({ t: 'Let', kind, target, type, init, line: kwTok.line, col: kwTok.col });
        if (!this.eatOp(',')) break;
        this.skipNl();
      }
      return decls.length === 1 ? decls[0] : { t: 'Seq', body: decls, line: kwTok.line };
    }

    parsePattern() {
      const t = this.tok;
      if (t.t === 'id') { this.next(); return { t: 'PId', name: t.v, line: t.line, col: t.col }; }
      if (this.isOp('[')) {
        this.next();
        const items = []; let rest = null;
        this.skipNl();
        while (!this.isOp(']')) {
          if (this.eatOp('...')) { rest = this.parsePattern(); }
          else if (this.isOp(',')) { items.push(null); }
          else items.push(this.parsePattern());
          this.skipNl();
          if (!this.eatOp(',')) break;
          this.skipNl();
        }
        this.expectOp(']');
        return { t: 'PList', items, rest, line: t.line, col: t.col };
      }
      if (this.isOp('{')) {
        this.next();
        const props = [];
        this.skipNl();
        while (!this.isOp('}')) {
          const kt = this.tok;
          if (kt.t !== 'id') this.fail('変数名が必要です');
          this.next();
          let pat = { t: 'PId', name: kt.v, line: kt.line, col: kt.col };
          if (this.eatOp(':')) pat = this.parsePattern();
          props.push({ key: kt.v, pat });
          this.skipNl();
          if (!this.eatOp(',')) break;
          this.skipNl();
        }
        this.expectOp('}');
        return { t: 'PMap', props, line: t.line, col: t.col };
      }
      this.fail(`変数名が必要ですが、${this.desc(t)} が見つかりました`);
    }

    toPattern(e) {
      switch (e.t) {
        case 'Id': return { t: 'PId', name: e.name, line: e.line, col: e.col };
        case 'Member': case 'Index': return { t: 'PExpr', expr: e, line: e.line, col: e.col };
        case 'List': {
          const items = []; let rest = null;
          for (let k = 0; k < e.items.length; k++) {
            const it = e.items[k];
            if (it.t === 'Spread') {
              if (k !== e.items.length - 1) throw new PreError('SyntaxError', '... は最後にしか書けません', it.line, it.col);
              rest = this.toPattern(it.arg);
            } else items.push(this.toPattern(it));
          }
          return { t: 'PList', items, rest, line: e.line, col: e.col };
        }
        default: throw new PreError('SyntaxError', '代入できない式です', e.line, e.col);
      }
    }

    parseParams() {
      this.expectOp('(');
      const params = [];
      this.skipNl();
      while (!this.isOp(')')) {
        const pt = this.tok;
        const rest = this.eatOp('...');
        if (this.tok.t !== 'id') this.fail(`引数名が必要ですが、${this.desc(this.tok)} が見つかりました`);
        const name = this.next().v;
        let type = null, def = null;
        if (this.eatOp(':')) type = this.parseType();
        if (this.eatOp('=')) def = this.parseAssign();
        params.push({ name, type, def, rest, line: pt.line });
        this.skipNl();
        if (!this.eatOp(',')) break;
        this.skipNl();
      }
      this.expectOp(')');
      return params;
    }
    arity(params) {
      let min = 0, max = 0, sawOpt = false;
      for (const p of params) {
        if (p.rest) { max = Infinity; sawOpt = true; continue; }
        max++;
        if (p.def) sawOpt = true;
        if (!sawOpt) min = max;
      }
      return [min, max];
    }
    parseFunction(name, startTok) {
      const params = this.parseParams();
      let retType = null;
      if (this.eatOp(':')) retType = this.parseType();
      let body, exprBody = false;
      if (this.isOp('=>')) { this.next(); this.skipNl(); body = this.parseAssign(); exprBody = true; }
      else body = this.parseBlock();
      const [minArgs, maxArgs] = this.arity(params);
      return { t: 'Fn', name, params, body, exprBody, retType, minArgs, maxArgs, line: startTok.line, col: startTok.col };
    }

    parseClass() {
      const t = this.next();
      if (this.tok.t !== 'id') this.fail('クラス名が必要です');
      const name = this.next().v;
      let superName = null;
      if (this.eatKw('extends')) {
        if (this.tok.t !== 'id') this.fail('親クラス名が必要です');
        superName = this.next().v;
      }
      this.skipNl();
      const open = this.tok;
      this.expectOp('{');
      const methods = [], fields = [];
      this.skipTerms();
      while (!this.isOp('}')) {
        if (this.tok.t === 'eof') this.fail("'}' が見つかりません (クラスが閉じられていません)", open);
        if (this.isKw('fn') && this.peekTok().t === 'id') this.next();
        const nt = this.tok;
        if (nt.t !== 'id') this.fail(`クラスの中に ${this.desc(nt)} は書けません (メソッドかフィールドを書きます)`);
        this.next();
        if (this.isOp('(')) {
          const f = this.parseFunction(nt.v === 'init' ? 'constructor' : nt.v, nt);
          f.t = 'FnDecl';
          methods.push(f);
          if (f.exprBody) this.endStmt();
        } else {
          let type = null, init = null;
          if (this.eatOp(':')) type = this.parseType();
          if (this.eatOp('=')) init = this.parseExpr();
          this.endStmt();
          fields.push({ name: nt.v, type, init, line: nt.line });
        }
        this.skipTerms();
      }
      this.next();
      return { t: 'ClassDecl', name, superName, methods, fields, line: t.line, col: t.col };
    }

    parseIf() {
      const t = this.next();
      const cond = this.parseExpr();
      const then = this.parseBlock();
      let alt = null;
      const save = this.p;
      this.skipNl();
      if (this.isKw('else')) {
        this.next();
        if (this.isKw('if')) alt = this.parseIf();
        else alt = this.parseBlock();
      } else if (this.isKw('elif')) {
        alt = this.parseIf();
      } else this.p = save;
      return { t: 'If', cond, then, else: alt, line: t.line, col: t.col };
    }

    isIn() { return this.isKw('in') || (this.tok.t === 'id' && this.tok.v === 'of'); }
    parseBindings() {
      const pats = [this.parsePattern()];
      while (this.eatOp(',')) pats.push(this.parsePattern());
      return pats.length === 1 ? pats[0] : { t: 'PList', items: pats, rest: null, line: pats[0].line, col: pats[0].col };
    }
    parseFor() {
      const t = this.next();
      let paren = false;
      if (this.isOp('(')) {
        // for (x in xs) / for (let x of xs) の形か、C 風の for (init; cond; update) か
        let k = this.p + 1;
        if (this.toks[k].t === 'kw' && (this.toks[k].v === 'let' || this.toks[k].v === 'const')) k++;
        while (this.toks[k].t === 'id' && this.toks[k + 1].t === 'op' && this.toks[k + 1].v === ',') k += 2;
        const a = this.toks[k], b = this.toks[k + 1];
        if (a.t === 'id' && b && ((b.t === 'kw' && b.v === 'in') || (b.t === 'id' && b.v === 'of'))) paren = true;
        if (!paren) return this.parseForC(t);
        this.next();
      }
      if (this.isKw('let') || this.isKw('const')) this.next();
      const pat = this.parseBindings();
      if (!this.isIn()) this.fail(`'in' が必要ですが、${this.desc(this.tok)} が見つかりました (for x in リスト { ... } の形で書きます)`);
      this.next();
      const iter = this.parseExpr();
      if (paren) this.expectOp(')');
      const body = this.parseBlock();
      return { t: 'ForIn', pat, iter, body, line: t.line, col: t.col };
    }
    parseForC(t) {
      this.expectOp('(');
      let init = null, cond = null, update = null;
      if (!this.isOp(';')) {
        if (this.isKw('let') || this.isKw('const')) init = this.parseLet();
        else { const e = this.parseExpr(); init = { t: 'Expr', expr: e, line: e.line }; }
      }
      this.expectOp(';');
      if (!this.isOp(';')) cond = this.parseExpr();
      this.expectOp(';');
      if (!this.isOp(')')) update = this.parseExpr();
      this.expectOp(')');
      const body = this.parseBlock();
      return { t: 'ForC', init, cond, update, body, line: t.line, col: t.col };
    }

    parseTry() {
      const t = this.next();
      const block = this.parseBlock();
      let param = null, handler = null, finalizer = null;
      let save = this.p;
      this.skipNl();
      if (this.isKw('catch')) {
        this.next();
        if (this.eatOp('(')) { if (this.tok.t !== 'id') this.fail('エラーを受け取る変数名が必要です'); param = this.next().v; this.expectOp(')'); }
        else if (this.tok.t === 'id') param = this.next().v;
        handler = this.parseBlock();
        save = this.p;
        this.skipNl();
      }
      if (this.isKw('finally')) { this.next(); finalizer = this.parseBlock(); }
      else this.p = save;
      if (!handler && !finalizer) this.fail('try には catch か finally が必要です', t);
      return { t: 'Try', block, param, handler, finalizer, line: t.line, col: t.col };
    }

    /* ── match (パターンマッチ) ── */
    parseMatch() {
      const t = this.next();
      const subject = this.parseExpr();
      const open = this.tok;
      this.expectOp('{', "match の '{'");
      this.skipTerms();
      const arms = [];
      while (!this.isOp('}')) {
        if (this.tok.t === 'eof') this.fail("'}' が見つかりません (match が閉じられていません)", open);
        arms.push(this.parseMatchArm());
        if (!(this.isOp(',') || this.tok.t === 'nl' || this.isOp(';') || this.isOp('}'))) {
          this.fail(`${this.desc(this.tok)} は予期しない位置にあります (match の腕は改行か , で区切ります)`);
        }
        if (this.isOp(',')) this.next();
        this.skipTerms();
      }
      this.next();
      if (!arms.length) this.fail('match には「パターン => 結果」を 1 つ以上書いてください', t);
      return { t: 'Match', subject, arms, stmt: false, line: t.line, col: t.col };
    }
    parseMatchArm() {
      const st = this.tok;
      const pat = this.parseMatchPattern();
      let guard = null;
      if (this.isKw('if')) { this.next(); guard = this.parseTernary(); }
      if (!this.isOp('=>')) this.fail(`'=>' が必要ですが、${this.desc(this.tok)} が見つかりました (パターン => 結果 の形で書きます)`);
      this.next();
      this.skipNl();
      let kind, node;
      const k = this.tok;
      if (this.isOp('{')) { kind = 'block'; node = this.parseBlock(); }
      else if (k.t === 'kw' && (k.v === 'return' || k.v === 'break' || k.v === 'continue' || k.v === 'throw')) { kind = 'stmt'; node = this.parseStatement(); }
      else { kind = 'expr'; node = this.parseAssign(); }
      return { pat, guard, kind, node, line: st.line, col: st.col };
    }
    parseMatchPattern() {
      const first = this.parseMatchAtom();
      if (!this.isOp('|')) return first;
      const alts = [first];
      while (this.isOp('|')) { this.next(); this.skipNl(); alts.push(this.parseMatchAtom()); }
      return { t: 'MOr', alts, line: first.line, col: first.col };
    }
    parseMatchAtom() {
      const t = this.tok;
      const at = { line: t.line, col: t.col };
      if (t.t === 'id') {
        this.next();
        if (this.isOp(':')) { this.next(); const type = this.parseType(); return { t: 'MIs', name: t.v === '_' ? null : t.v, type, ...at }; }
        if (t.v === '_') return { t: 'MWild', ...at };
        return { t: 'MBind', name: t.v, ...at };
      }
      if (t.t === 'num' || t.t === 'str') { this.next(); return { t: 'MLit', v: t.v, ...at }; }
      if (this.isOp('-') && this.peekTok().t === 'num') { this.next(); const n = this.next(); return { t: 'MLit', v: -n.v, ...at }; }
      if (t.t === 'kw' && (t.v === 'true' || t.v === 'false' || t.v === 'null')) {
        this.next();
        return { t: 'MLit', v: t.v === 'null' ? null : t.v === 'true', ...at };
      }
      if (this.isOp('(')) { this.next(); const p = this.parseMatchPattern(); this.expectOp(')'); return p; }
      const restName = () => {
        const rt = this.tok;
        if (rt.t !== 'id') this.fail(`... の後には名前が必要ですが、${this.desc(rt)} が見つかりました`);
        this.next();
        return rt.v === '_' ? { t: 'MWild', line: rt.line, col: rt.col } : { t: 'MBind', name: rt.v, line: rt.line, col: rt.col };
      };
      if (this.isOp('[')) {
        this.next();
        const items = []; let rest = null;
        this.skipNl();
        while (!this.isOp(']')) {
          if (this.eatOp('...')) rest = restName();
          else items.push(this.parseMatchPattern());
          this.skipNl();
          if (!this.eatOp(',')) break;
          this.skipNl();
        }
        this.skipNl();
        this.expectOp(']', "リストパターンの ']'");
        return { t: 'MList', items, rest, ...at };
      }
      if (this.isOp('{')) {
        this.next();
        const props = []; let rest = null;
        this.skipNl();
        while (!this.isOp('}')) {
          if (this.eatOp('...')) rest = restName();
          else {
            const kt = this.tok;
            if (kt.t !== 'id' && kt.t !== 'str' && kt.t !== 'kw') this.fail(`マップパターンのキーが必要ですが、${this.desc(kt)} が見つかりました`);
            this.next();
            let pat;
            if (this.eatOp(':')) pat = this.parseMatchPattern();
            else if (kt.t === 'id') pat = { t: 'MBind', name: kt.v, line: kt.line, col: kt.col };
            else this.fail("マップパターンの ':' が必要です");
            props.push({ key: kt.v, pat });
          }
          this.skipNl();
          if (!this.eatOp(',')) break;
          this.skipNl();
        }
        this.skipNl();
        this.expectOp('}', "マップパターンの '}'");
        return { t: 'MMap', props, rest, ...at };
      }
      this.fail(`パターンが必要ですが、${this.desc(t)} が見つかりました (例: 0 / "a" / [x, y] / {name} / n: number / _)`);
    }

    parseType() {
      const items = [this.parseTypePrimary()];
      while (this.isOp('|')) { this.next(); items.push(this.parseTypePrimary()); }
      return items.length === 1 ? items[0] : { k: 'union', items };
    }
    expectGt() {
      const t = this.tok;
      if (t.t === 'op' && t.v === '>') { this.next(); return; }
      if (t.t === 'op' && t.v === '>>') { t.v = '>'; return; }
      this.fail(`'>' が必要ですが、${this.desc(t)} が見つかりました`);
    }
    parseTypePrimary() {
      const t = this.tok;
      let ty;
      if (t.t === 'id' || (t.t === 'kw' && (t.v === 'fn' || t.v === 'null'))) {
        this.next();
        const args = [];
        if (this.isOp('<')) {
          this.next();
          args.push(this.parseType());
          while (this.eatOp(',')) args.push(this.parseType());
          this.expectGt();
        }
        ty = { k: 'name', name: t.v, args };
      } else if (this.isOp('(')) {
        this.next(); ty = this.parseType(); this.expectOp(')');
      } else this.fail(`型名が必要ですが、${this.desc(t)} が見つかりました`);
      while (this.isOp('[') && this.peekTok().t === 'op' && this.peekTok().v === ']') { this.next(); this.next(); ty = { k: 'name', name: 'list', args: [ty] }; }
      if (this.isOp('?')) { this.next(); ty = { k: 'union', items: [ty, { k: 'name', name: 'null', args: [] }] }; }
      return ty;
    }

    /* ── 式 ── */
    parseExpr() { return this.parseAssign(); }

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

    parseAssign() {
      const t = this.tok;
      if (t.t === 'id' && this.peekTok().t === 'op' && this.peekTok().v === '=>') {
        this.next(); this.next(); this.skipNl();
        const params = [{ name: t.v, type: null, def: null, rest: false, line: t.line }];
        return this.finishArrow(params, t);
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
        this.next(); this.skipNl();
        const right = this.parseAssign();
        if (left.t === 'Id' || left.t === 'Member' || left.t === 'Index') return { t: 'Assign', op: ot.v, target: left, value: right, line: ot.line, col: ot.col };
        if (left.t === 'List' && ot.v === '=') return { t: 'Assign', op: '=', target: { t: 'Destructure', pattern: this.toPattern(left) }, value: right, line: ot.line, col: ot.col };
        this.fail('代入できない式です (変数・要素・プロパティにだけ代入できます)', ot);
      }
      return left;
    }
    finishArrow(params, t) {
      const [minArgs, maxArgs] = this.arity(params);
      let body, exprBody = false;
      if (this.isOp('{')) body = this.parseBlock();
      else { body = this.parseAssign(); exprBody = true; }
      return { t: 'Fn', name: '', params, body, exprBody, retType: null, minArgs, maxArgs, line: t.line, col: t.col };
    }

    parsePipe() {
      let left = this.parseBinary(1);
      while (this.isOp('|>')) {
        const t = this.next();
        this.skipNl();
        const right = this.parseBinary(1);
        left = { t: 'Pipe', l: left, r: right, line: t.line, col: t.col };
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

    binInfo(t) {
      if (t.t === 'op') {
        if (CMP_OPS.has(t.v)) return { op: t.v === '===' ? '==' : t.v === '!==' ? '!=' : t.v, prec: 5, cmp: true };
        const pr = BIN_PREC[t.v];
        return pr ? { op: t.v, prec: pr } : null;
      }
      if (t.t === 'kw') {
        if (t.v === 'or') return { op: '||', prec: 2 };
        if (t.v === 'and') return { op: '&&', prec: 3 };
        if (t.v === 'in') return { op: 'in', prec: 5, cmp: true };
        if (t.v === 'not') { const nx = this.peekTok(); if (nx.t === 'kw' && nx.v === 'in') return { op: 'not in', prec: 5, cmp: true, two: true }; }
      }
      return null;
    }
    parseBinary(minPrec) {
      let left;
      if (this.isKw('not') && minPrec <= 4) {
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
            operands.push(this.parseBinary(6));
          }
          left = { t: 'Compare', ops, operands, line: opTok.line, col: opTok.col };
          continue;
        }
        this.next(); this.skipNl();
        const right = this.parseBinary(info.prec + 1);
        const logical = info.op === '&&' || info.op === '||' || info.op === '??';
        left = { t: logical ? 'Logical' : 'Binary', op: info.op, l: left, r: right, line: opTok.line, col: opTok.col };
      }
      return left;
    }

    parseUnary() {
      const t = this.tok;
      if (t.t === 'op') {
        if (t.v === '-' || t.v === '+' || t.v === '!' || t.v === '~') {
          this.next();
          const arg = this.parseUnary();
          return { t: 'Unary', op: t.v === '!' ? 'not' : t.v, arg, line: t.line, col: t.col };
        }
        if (t.v === '++' || t.v === '--') {
          this.next();
          const target = this.parseUnary();
          this.checkTarget(target, t);
          return { t: 'Update', op: t.v, prefix: true, target, line: t.line, col: t.col };
        }
      }
      if (t.t === 'kw' && t.v === 'new') {
        this.next();
        let e = this.parsePostfix();
        if (e.t !== 'Call') e = { t: 'Call', callee: e, args: [], line: t.line, col: t.col };
        return e;
      }
      return this.parsePower();
    }
    parsePower() {
      const base = this.parsePostfix();
      if (this.isOp('**')) {
        const t = this.next();
        this.skipNl();
        const exp = this.parseUnary();
        return { t: 'Binary', op: '**', l: base, r: exp, line: t.line, col: t.col };
      }
      return base;
    }
    checkTarget(e, t) {
      if (e.t !== 'Id' && e.t !== 'Member' && e.t !== 'Index') this.fail('++ / -- は変数・要素・プロパティにだけ使えます', t);
    }

    parseArgs() {
      this.expectOp('(');
      const args = [];
      this.skipNl();
      while (!this.isOp(')')) {
        const t = this.tok;
        if (this.eatOp('...')) args.push({ t: 'Spread', arg: this.parseAssign(), line: t.line, col: t.col });
        else args.push(this.parseAssign());
        this.skipNl();
        if (!this.eatOp(',')) break;
        this.skipNl();
      }
      this.expectOp(')', "関数呼び出しの ')'");
      return args;
    }
    parseIndexRest(obj, optional) {
      const open = this.next();
      let start = null, end = null, isSlice = false;
      if (this.isOp(':')) { isSlice = true; this.next(); if (!this.isOp(']')) end = this.parseAssign(); }
      else {
        start = this.parseAssign();
        if (this.eatOp(':')) { isSlice = true; if (!this.isOp(']')) end = this.parseAssign(); }
      }
      this.expectOp(']');
      return isSlice
        ? { t: 'Slice', obj, start, end, optional, line: open.line, col: open.col }
        : { t: 'Index', obj, index: start, optional, line: open.line, col: open.col };
    }
    parsePostfix() {
      let e = this.parsePrimary();
      let chain = false;
      for (;;) {
        const t = this.tok;
        if (t.t !== 'op') break;
        if (t.v === '(') {
          e = { t: 'Call', callee: e, args: this.parseArgs(), optional: false, line: t.line, col: t.col };
        } else if (t.v === '.') {
          this.next();
          const nt = this.tok;
          if (nt.t !== 'id' && nt.t !== 'kw') this.fail(`プロパティ名が必要ですが、${this.desc(nt)} が見つかりました`);
          this.next();
          e = { t: 'Member', obj: e, prop: nt.v, optional: false, line: nt.line, col: nt.col };
        } else if (t.v === '?.') {
          this.next(); chain = true;
          const nt = this.tok;
          if (nt.t === 'op' && nt.v === '(') e = { t: 'Call', callee: e, args: this.parseArgs(), optional: true, line: nt.line, col: nt.col };
          else if (nt.t === 'op' && nt.v === '[') e = this.parseIndexRest(e, true);
          else if (nt.t === 'id' || nt.t === 'kw') { this.next(); e = { t: 'Member', obj: e, prop: nt.v, optional: true, line: nt.line, col: nt.col }; }
          else this.fail("'?.' の後にはプロパティ名が必要です");
        } else if (t.v === '[') {
          e = this.parseIndexRest(e, false);
        } else if (t.v === '++' || t.v === '--') {
          this.checkTarget(e, t);
          this.next();
          e = { t: 'Update', op: t.v, prefix: false, target: e, line: t.line, col: t.col };
        } else break;
      }
      return chain ? { t: 'Chain', expr: e, line: e.line, col: e.col } : e;
    }

    parseTemplateExpr(src, line) {
      const sub = new Parser(tokenize(src, line));
      sub.skipNl();
      const e = sub.parseExpr();
      sub.skipNl();
      if (sub.tok.t !== 'eof') sub.fail(`文字列の中の式に ${sub.desc(sub.tok)} は書けません`);
      return e;
    }

    parsePrimary() {
      const t = this.tok;
      switch (t.t) {
        case 'num': this.next(); return { t: 'Lit', v: t.v, line: t.line, col: t.col };
        case 'str': this.next(); return { t: 'Lit', v: t.v, line: t.line, col: t.col };
        case 'tpl': {
          this.next();
          const parts = t.v.map((p) => {
            if (typeof p === 'string') return p;
            const e = this.parseTemplateExpr(p.src, p.line);
            return p.spec != null ? { t: 'Fmt', expr: e, spec: p.spec, line: p.line, col: t.col } : e;
          });
          return { t: 'Tpl', parts, line: t.line, col: t.col };
        }
        case 'id': this.next(); return { t: 'Id', name: t.v, line: t.line, col: t.col };
        case 'kw':
          switch (t.v) {
            case 'true': this.next(); return { t: 'Lit', v: true, line: t.line, col: t.col };
            case 'false': this.next(); return { t: 'Lit', v: false, line: t.line, col: t.col };
            case 'null': this.next(); return { t: 'Lit', v: null, line: t.line, col: t.col };
            case 'this': this.next(); return { t: 'This', line: t.line, col: t.col };
            case 'super': this.next(); return { t: 'Super', line: t.line, col: t.col };
            case 'fn':
              if (this.peekTok().t === 'op' && this.peekTok().v === '(') { this.next(); return this.parseFunction('', t); }
              break;
            case 'match': return this.parseMatch();
            default: break;
          }
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
          if (t.v === '{') return this.parseMap();
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
        const t = this.tok;
        if (this.eatOp('...')) items.push({ t: 'Spread', arg: this.parseAssign(), line: t.line, col: t.col });
        else {
          const e = this.parseAssign();
          if (items.length === 0 && this.isKw('for')) return this.parseComp(e, open);
          items.push(e);
        }
        this.skipNl();
        if (!this.eatOp(',')) break;
        this.skipNl();
      }
      this.skipNl();
      this.expectOp(']', "リストの ']'");
      return { t: 'List', items, line: open.line, col: open.col };
    }
    parseComp(elem, open) {
      const clauses = [];
      while (this.isKw('for') || this.isKw('if')) {
        if (this.eatKw('for')) {
          const pat = this.parseBindings();
          if (!this.isIn()) this.fail("内包表記の for には 'in' が必要です");
          this.next();
          clauses.push({ pat, iter: this.parseTernary() });
        } else {
          this.next();
          clauses.push({ cond: this.parseTernary() });
        }
        this.skipNl();
      }
      this.expectOp(']', "リストの ']'");
      return { t: 'ListComp', elem, clauses, line: open.line, col: open.col };
    }
    parseMap() {
      const open = this.next();
      const entries = [];
      this.skipNl();
      while (!this.isOp('}')) {
        const t = this.tok;
        if (this.eatOp('...')) entries.push({ spread: this.parseAssign() });
        else {
          let key, computed = false, short = null;
          if (this.isOp('[')) { this.next(); key = this.parseExpr(); this.expectOp(']'); computed = true; }
          else if (t.t === 'id') { this.next(); key = t.v; short = t.v; }
          else if (t.t === 'kw' || t.t === 'str' || t.t === 'num') { this.next(); key = t.v; }
          else this.fail(`マップのキーが必要ですが、${this.desc(t)} が見つかりました`);
          let value;
          this.skipNl();
          if (this.eatOp(':')) { this.skipNl(); value = this.parseAssign(); }
          else if (short) value = { t: 'Id', name: short, line: t.line, col: t.col };
          else this.fail("マップの ':' が必要です");
          entries.push({ key, computed, value });
        }
        this.skipNl();
        if (!this.eatOp(',')) break;
        this.skipNl();
      }
      this.skipNl();
      this.expectOp('}', "マップの '}'");
      return { t: 'Map', entries, line: open.line, col: open.col };
    }
  }

  function parse(src) { return new Parser(tokenize(src, 1)).parseProgram(); }

  /* ═════════════ 表示・型の補助 ═════════════ */
  function typeName(v) {
    if (v === null || v === undefined) return 'null';
    switch (typeof v) {
      case 'number': return 'number';
      case 'string': return 'string';
      case 'boolean': return 'bool';
      case 'function': return 'fn';
      default: break;
    }
    if (Array.isArray(v)) return 'list';
    if (v instanceof Map) return 'map';
    if (v instanceof PreInstance) return v.cls.name;
    if (v instanceof PreFunction || v instanceof BoundMethod) return 'fn';
    if (v instanceof PreClass) return 'class';
    return 'unknown';
  }
  function typeStr(t) {
    if (t.k === 'union') return t.items.map(typeStr).join(' | ');
    return t.args && t.args.length ? `${t.name}<${t.args.map(typeStr).join(', ')}>` : t.name;
  }
  function fmtNum(x) {
    if (Object.is(x, -0)) return '0';
    return String(x);
  }
  const IDENT_ONLY = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

  /* ═════════════ インタープリタ ═════════════ */
  const PRELUDE = `
class Error {
  message = ""
  name = "Error"
  constructor(message = "") {
    this.message = message
    this.name = type(this)
  }
  toString() {
    return this.name + ": " + this.message
  }
}
class TypeError extends Error {}
class NameError extends Error {}
class ValueError extends Error {}
class IndexError extends Error {}
class AttributeError extends Error {}
class ZeroDivisionError extends Error {}
class RecursionError extends Error {}
class AssertionError extends Error {}
class EOFError extends Error {}
`;

  class Interpreter {
    constructor(opts) {
      opts = opts || {};
      this.opts = opts;
      this.sink = opts.print || ((s) => { if (typeof process !== 'undefined') process.stdout.write(s); });
      this.maxOutput = opts.maxOutput || 2000000;
      this.timeLimit = opts.timeLimit || 10000;
      this.outLen = 0;
      this.depth = 0; this.steps = 0; this.deadline = Infinity; this.line = 0;
      this.allowRedeclare = false;
      this.builtins = new Env(null);
      this.global = new Env(this.builtins);
      installBuiltins(this);
      this.execIn(parse(PRELUDE), this.builtins);
    }

    write(s) {
      this.outLen += s.length;
      if (this.outLen > this.maxOutput) { const e = new PreError('OutputLimit', `出力が多すぎます (上限 ${this.maxOutput} 文字)`, this.line); e.fatal = true; throw e; }
      this.sink(s);
    }
    fail(kind, msg, n) { throw new PreError(kind, msg, n && n.line != null ? n.line : this.line, n && n.col != null ? n.col : null); }
    tick() {
      if ((++this.steps & 0x1fff) === 0 && now() > this.deadline) {
        const e = new PreError('TimeoutError', `実行時間が長すぎます (${Math.round(this.timeLimit / 1000)}秒)。無限ループになっていませんか？`, this.line);
        e.fatal = true; throw e;
      }
    }

    /* ── 変数 ── */
    peekVar(name, env) { for (let e = env; e; e = e.parent) { const v = e.vars.get(name); if (v !== undefined) return v; } return undefined; }
    allNames(env) { const s = new Set(); for (let e = env; e; e = e.parent) for (const k of e.vars.keys()) s.add(k); return Array.from(s); }
    lookup(name, env, n) {
      for (let e = env; e; e = e.parent) { const v = e.vars.get(name); if (v !== undefined) return v; }
      this.nameError(name, env, n);
    }
    nameError(name, env, n) {
      let msg = `変数 '${name}' は定義されていません`;
      if (name === 'self') msg += ' (Pre では self ではなく this を使います)';
      else if (name === 'True' || name === 'False') msg += ` (${name.toLowerCase()} と小文字で書きます)`;
      else if (name === 'None' || name === 'undefined' || name === 'nil') msg += ' (何もない値は null です)';
      else { const c = closest(name, this.allNames(env)); if (c) msg += ` (もしかして: ${c} ?)`; }
      this.fail('NameError', msg, n);
    }
    declare(env, name, v, isConst, n) {
      if (env.vars.has(name) && !this.allowRedeclare) this.fail('NameError', `変数 '${name}' はこの範囲ですでに定義されています`, n);
      env.define(name, v, isConst);
    }
    assignVar(name, v, env, n) {
      for (let e = env; e; e = e.parent) {
        if (e.vars.has(name)) {
          if (e.consts && e.consts.has(name)) this.fail('TypeError', `定数 '${name}' には再代入できません`, n);
          e.vars.set(name, v === undefined ? null : v);
          return;
        }
      }
      let msg = `変数 '${name}' は定義されていません (最初に let で宣言してください)`;
      const c = closest(name, this.allNames(env));
      if (c) msg = `変数 '${name}' は定義されていません (もしかして: ${c} ?)`;
      this.fail('NameError', msg, n);
    }

    bind(p, v, env, mode, n) {
      switch (p.t) {
        case 'PId':
          if (mode === 'assign') this.assignVar(p.name, v, env, p);
          else this.declare(env, p.name, v, mode === 'const', p);
          return;
        case 'PExpr': this.assignTo(p.expr, v, env); return;
        case 'PList': {
          const arr = Array.isArray(v) ? v : typeof v === 'string' ? Array.from(v) : null;
          if (!arr) this.fail('TypeError', `${typeName(v)} は分解代入できません (リストが必要です)`, p);
          for (let i = 0; i < p.items.length; i++) { const it = p.items[i]; if (it) this.bind(it, i < arr.length ? arr[i] : null, env, mode, n); }
          if (p.rest) this.bind(p.rest, arr.slice(p.items.length), env, mode, n);
          return;
        }
        case 'PMap':
          for (const pr of p.props) {
            let x = null;
            if (v instanceof Map) x = v.has(pr.key) ? v.get(pr.key) : null;
            else if (v instanceof PreInstance) x = v.props.has(pr.key) ? v.props.get(pr.key) : null;
            else this.fail('TypeError', `${typeName(v)} はマップとして分解代入できません`, p);
            this.bind(pr.pat, x, env, mode, n);
          }
          return;
        default: this.fail('SyntaxError', '分解代入の形が不正です', p);
      }
    }
    assignTo(t, v, env) {
      switch (t.t) {
        case 'Id': this.assignVar(t.name, v, env, t); return;
        case 'Member': this.setMember(this.ev(t.obj, env), t.prop, v, t); return;
        case 'Index': this.setIndex(this.ev(t.obj, env), this.ev(t.index, env), v, t); return;
        default: this.fail('SyntaxError', '代入できない式です', t);
      }
    }

    /* ── 型チェック ── */
    matches(v, t, env) {
      if (t.k === 'union') { for (const it of t.items) if (this.matches(v, it, env)) return true; return false; }
      switch (t.name) {
        case 'any': return true;
        case 'number': case 'float': return typeof v === 'number';
        case 'int': return typeof v === 'number' && Number.isInteger(v);
        case 'string': case 'str': return typeof v === 'string';
        case 'bool': case 'boolean': return typeof v === 'boolean';
        case 'null': case 'none': return v === null || v === undefined;
        case 'fn': case 'function': return typeof v === 'function' || v instanceof PreFunction || v instanceof BoundMethod || v instanceof PreClass;
        case 'list': case 'array':
          if (!Array.isArray(v)) return false;
          if (t.args.length) return v.every((x) => this.matches(x, t.args[0], env));
          return true;
        case 'map': case 'dict': case 'object':
          if (!(v instanceof Map)) return false;
          if (t.args.length === 2) { for (const [k, x] of v) if (!this.matches(k, t.args[0], env) || !this.matches(x, t.args[1], env)) return false; }
          else if (t.args.length === 1) { for (const x of v.values()) if (!this.matches(x, t.args[0], env)) return false; }
          return true;
        default: {
          const c = this.peekVar(t.name, env);
          if (c instanceof PreClass) return v instanceof PreInstance && v.cls.isSub(c);
          return true;
        }
      }
    }
    checkType(v, t, what, n, env) {
      if (!this.matches(v, t, env)) {
        this.fail('TypeError', `${what} は ${typeStr(t)} 型のはずですが、${typeName(v)} の値 ${this.short(v)} が入っています`, n);
      }
    }
    short(v) { const s = this.repr(v, 0, []); return s.length > 40 ? s.slice(0, 37) + '...' : s; }

    /* ── 表示 ── */
    toStr(v) {
      if (v === null || v === undefined) return 'null';
      switch (typeof v) {
        case 'string': return v;
        case 'number': return fmtNum(v);
        case 'boolean': return v ? 'true' : 'false';
        default: return this.repr(v, 0, []);
      }
    }
    display(v) { return typeof v === 'string' ? JSON.stringify(v) : this.toStr(v); }
    repr(v, depth, seen) {
      if (v === null || v === undefined) return 'null';
      switch (typeof v) {
        case 'string': return JSON.stringify(v);
        case 'number': return fmtNum(v);
        case 'boolean': return v ? 'true' : 'false';
        case 'function': return `<builtin ${v.preName || 'fn'}>`;
        default: break;
      }
      if (Array.isArray(v)) {
        if (seen.indexOf(v) >= 0 || depth > 8) return '[...]';
        seen.push(v);
        const s = '[' + v.map((x) => this.repr(x, depth + 1, seen)).join(', ') + ']';
        seen.pop();
        return s;
      }
      if (v instanceof Map) {
        if (seen.indexOf(v) >= 0 || depth > 8) return '{...}';
        seen.push(v);
        const parts = [];
        for (const [k, x] of v) {
          const ks = typeof k === 'string' ? (IDENT_ONLY.test(k) ? k : JSON.stringify(k)) : this.repr(k, depth + 1, seen);
          parts.push(ks + ': ' + this.repr(x, depth + 1, seen));
        }
        seen.pop();
        return '{' + parts.join(', ') + '}';
      }
      if (v instanceof PreInstance) {
        const m = v.cls.findMethod('toString');
        if (m) { const r = this.callFn(m, [], v, null); return typeof r === 'string' ? r : this.toStr(r); }
        if (seen.indexOf(v) >= 0 || depth > 8) return v.cls.name + ' {...}';
        seen.push(v);
        const parts = [];
        for (const [k, x] of v.props) parts.push(k + ': ' + this.repr(x, depth + 1, seen));
        seen.pop();
        return v.cls.name + ' {' + parts.join(', ') + '}';
      }
      if (v instanceof PreFunction) return `<fn ${v.name || 'anonymous'}>`;
      if (v instanceof BoundMethod) return `<method ${v.fn.name}>`;
      if (v instanceof PreClass) return `<class ${v.name}>`;
      return String(v);
    }

    truthy(v) {
      if (v === true) return true;
      if (v === false || v === null || v === undefined) return false;
      if (typeof v === 'number') return v !== 0 && v === v;
      if (typeof v === 'string') return v.length > 0;
      if (Array.isArray(v)) return v.length > 0;
      if (v instanceof Map) return v.size > 0;
      return true;
    }
    eq(a, b) {
      if (a === b) return true;
      if (a === null || a === undefined) return b === null || b === undefined;
      if (typeof a !== 'object' || typeof b !== 'object' || b === null) return false;
      if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) if (!this.eq(a[i], b[i])) return false;
        return true;
      }
      if (a instanceof Map) {
        if (!(b instanceof Map) || a.size !== b.size) return false;
        for (const [k, x] of a) { if (!b.has(k) || !this.eq(x, b.get(k))) return false; }
        return true;
      }
      return false;
    }
    cmp(a, b, n) {
      if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0;
      if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
      if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
      if (Array.isArray(a) && Array.isArray(b)) {
        const m = Math.min(a.length, b.length);
        for (let i = 0; i < m; i++) { const c = this.cmp(a[i], b[i], n); if (c !== 0) return c; }
        return a.length - b.length;
      }
      this.fail('TypeError', `${typeName(a)} と ${typeName(b)} は大小を比べられません`, n);
    }
    contains(c, x, n) {
      if (Array.isArray(c)) { for (let i = 0; i < c.length; i++) if (this.eq(c[i], x)) return true; return false; }
      if (typeof c === 'string') {
        if (typeof x !== 'string') this.fail('TypeError', `文字列の中を調べるには文字列が必要です (${typeName(x)} が渡されました)`, n);
        return c.indexOf(x) >= 0;
      }
      if (c instanceof Map) return c.has(x);
      if (c instanceof PreInstance) return c.props.has(x);
      this.fail('TypeError', `${typeName(c)} に対して 'in' は使えません`, n);
    }
    toIterable(v, n) {
      if (Array.isArray(v)) return v;
      if (typeof v === 'string') return Array.from(v);
      if (v instanceof Map) return Array.from(v.keys());
      if (typeof v === 'number') this.fail('TypeError', 'number はくり返せません (range(n) を使ってください)', n);
      this.fail('TypeError', `${typeName(v)} はくり返せません (リスト・文字列・マップが必要です)`, n);
    }

    /* ── 演算 ── */
    binop(op, a, b, n) {
      switch (op) {
        case '+':
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          if (typeof a === 'string' || typeof b === 'string') return this.toStr(a) + this.toStr(b);
          if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
          break;
        case '-': if (typeof a === 'number' && typeof b === 'number') return a - b; break;
        case '*':
          if (typeof a === 'number' && typeof b === 'number') return a * b;
          if (typeof a === 'string' && typeof b === 'number') return this.repeat(a, b, n);
          if (typeof a === 'number' && typeof b === 'string') return this.repeat(b, a, n);
          if (Array.isArray(a) && typeof b === 'number') { const out = []; for (let i = 0; i < b; i++) out.push(...a); return out; }
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
        case '&': if (typeof a === 'number' && typeof b === 'number') return a & b; break;
        case '|': if (typeof a === 'number' && typeof b === 'number') return a | b; break;
        case '^': if (typeof a === 'number' && typeof b === 'number') return a ^ b; break;
        case '<<': if (typeof a === 'number' && typeof b === 'number') return a << b; break;
        case '>>': if (typeof a === 'number' && typeof b === 'number') return a >> b; break;
        default: break;
      }
      this.fail('TypeError', `演算子 '${op}' は ${typeName(a)} と ${typeName(b)} には使えません`, n);
    }
    repeat(s, k, n) {
      if (!Number.isInteger(k) || k < 0) this.fail('ValueError', '繰り返す回数は 0 以上の整数にしてください', n);
      if (s.length * k > 50000000) this.fail('ValueError', '文字列が大きすぎます', n);
      return s.repeat(k);
    }
    cmpOp(op, a, b, n) {
      switch (op) {
        case '==': return this.eq(a, b);
        case '!=': return !this.eq(a, b);
        case '<': if (typeof a === 'number' && typeof b === 'number') return a < b; return this.cmp(a, b, n) < 0;
        case '>': if (typeof a === 'number' && typeof b === 'number') return a > b; return this.cmp(a, b, n) > 0;
        case '<=': if (typeof a === 'number' && typeof b === 'number') return a <= b; return this.cmp(a, b, n) <= 0;
        case '>=': if (typeof a === 'number' && typeof b === 'number') return a >= b; return this.cmp(a, b, n) >= 0;
        case 'in': return this.contains(b, a, n);
        case 'not in': return !this.contains(b, a, n);
        default: return false;
      }
    }

    /* ── 添字・メンバー ── */
    normIndex(len, i, n) {
      if (typeof i !== 'number' || !Number.isInteger(i)) this.fail('TypeError', `添字は整数である必要があります (${typeName(i)} が渡されました)`, n);
      const k = i < 0 ? i + len : i;
      if (k < 0 || k >= len) this.fail('IndexError', `添字 ${i} は範囲外です (長さ ${len})`, n);
      return k;
    }
    getIndex(o, i, n) {
      if (Array.isArray(o)) return o[this.normIndex(o.length, i, n)];
      if (typeof o === 'string') return o[this.normIndex(o.length, i, n)];
      if (o instanceof Map) { const v = o.get(i); return v === undefined ? null : v; }
      if (o === null || o === undefined) this.fail('TypeError', 'null の要素は取り出せません', n);
      this.fail('TypeError', `${typeName(o)} には [ ] で要素を取り出せません`, n);
    }
    setIndex(o, i, v, n) {
      if (Array.isArray(o)) { o[this.normIndex(o.length, i, n)] = v; return; }
      if (o instanceof Map) { o.set(i, v); return; }
      if (typeof o === 'string') this.fail('TypeError', '文字列の一部は書き換えられません', n);
      this.fail('TypeError', `${typeName(o)} には [ ] で要素を代入できません`, n);
    }
    sliceBounds(len, s, e, n) {
      const chk = (x) => { if (typeof x !== 'number' || !Number.isInteger(x)) this.fail('TypeError', 'スライスの範囲は整数にしてください', n); };
      if (s === null) s = 0; else { chk(s); if (s < 0) s += len; }
      if (e === null) e = len; else { chk(e); if (e < 0) e += len; }
      s = Math.max(0, Math.min(len, s)); e = Math.max(0, Math.min(len, e));
      return [s, e];
    }
    getMember(o, name, n) {
      if (o instanceof PreInstance) {
        if (o.props.has(name)) return o.props.get(name);
        const m = o.cls.findMethod(name);
        if (m) return new BoundMethod(m, o);
        const cands = Array.from(o.props.keys());
        for (let c = o.cls; c; c = c.parent) for (const k of c.methods.keys()) cands.push(k);
        const s = closest(name, cands);
        this.fail('AttributeError', `${o.cls.name} に '${name}' はありません${s ? ` (もしかして: ${s} ?)` : ''}`, n);
      }
      if (typeof o === 'string') {
        if (name === 'length') return o.length;
        const m = this.lib.STR[name];
        if (m) return this.bindNative(m, o, name);
        const s = closest(name, Object.keys(this.lib.STR));
        this.fail('AttributeError', `文字列に '${name}' というメソッドはありません${s ? ` (もしかして: ${s} ?)` : ''}`, n);
      }
      if (Array.isArray(o)) {
        if (name === 'length') return o.length;
        const m = this.lib.LIST[name];
        if (m) return this.bindNative(m, o, name);
        const s = closest(name, Object.keys(this.lib.LIST));
        this.fail('AttributeError', `リストに '${name}' というメソッドはありません${s ? ` (もしかして: ${s} ?)` : ''}`, n);
      }
      if (o instanceof Map) {
        if (o.has(name)) return o.get(name);
        const m = this.lib.MAP[name];
        if (m) return this.bindNative(m, o, name);
        return null;
      }
      if (typeof o === 'number') {
        const m = this.lib.NUM[name];
        if (m) return this.bindNative(m, o, name);
        this.fail('AttributeError', `数値に '${name}' というメソッドはありません`, n);
      }
      if (o instanceof PreClass) {
        if (name === 'name') return o.name;
        this.fail('AttributeError', `クラス ${o.name} に '${name}' はありません`, n);
      }
      if (o instanceof PreFunction) { if (name === 'name') return o.name; }
      if (o === null || o === undefined) this.fail('TypeError', `null の '${name}' は参照できません (?. を使うと安全に参照できます)`, n);
      this.fail('AttributeError', `${typeName(o)} に '${name}' はありません`, n);
    }
    bindNative(impl, self, name) {
      const f = (...args) => impl(self, ...args);
      f.preName = name;
      return f;
    }
    setMember(o, name, v, n) {
      if (o instanceof PreInstance) { o.props.set(name, v); return; }
      if (o instanceof Map) { o.set(name, v); return; }
      if (o === null || o === undefined) this.fail('TypeError', `null の '${name}' には代入できません`, n);
      this.fail('TypeError', `${typeName(o)} の '${name}' には代入できません`, n);
    }

    /* ── 関数呼び出し ── */
    call(f, args, n) {
      if (f instanceof PreFunction) return this.callFn(f, args, undefined, n);
      if (f instanceof BoundMethod) return this.callFn(f.fn, args, f.self, n);
      if (typeof f === 'function') { const r = f(...args); return r === undefined ? null : r; }
      if (f instanceof PreClass) return this.construct(f, args, n);
      if (f === null || f === undefined) this.fail('TypeError', 'null は関数として呼び出せません (名前のつづりを確認してください)', n);
      this.fail('TypeError', `${typeName(f)} は関数として呼び出せません`, n);
    }
    arityOf(f) {
      if (f instanceof PreFunction) return f.maxArgs;
      if (f instanceof BoundMethod) return f.fn.maxArgs;
      return 1;
    }
    callCb(f, ...vals) {
      let k = vals.length;
      if (f instanceof PreFunction) k = Math.min(k, f.maxArgs);
      else if (f instanceof BoundMethod) k = Math.min(k, f.fn.maxArgs);
      return this.call(f, vals.slice(0, k), null);
    }
    bindParams(fn, args, env, n) {
      const ps = fn.params;
      if (args.length < fn.minArgs || args.length > fn.maxArgs) {
        const want = fn.minArgs === fn.maxArgs ? `${fn.minArgs} 個` : fn.maxArgs === Infinity ? `${fn.minArgs} 個以上` : `${fn.minArgs}〜${fn.maxArgs} 個`;
        this.fail('TypeError', `関数 ${fn.name || '(無名)'} は引数を ${want}受け取りますが、${args.length} 個渡されました`, n);
      }
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        if (p.rest) { env.define(p.name, args.slice(i)); break; }
        const v = i < args.length ? args[i] : this.ev(p.def, env);
        if (p.type) this.checkType(v, p.type, `引数 '${p.name}'`, n, env);
        env.define(p.name, v);
      }
    }
    callFn(fn, args, self, n) {
      if (++this.depth > MAX_DEPTH) {
        this.depth--;
        this.fail('RecursionError', `再帰が深すぎます (${MAX_DEPTH} 回を超えました)。終了条件を確認してください`, n);
      }
      this.tick();
      const env = new Env(fn.env);
      if (self !== undefined) env.vars.set('this', self);
      env.home = fn.home;
      try {
        this.bindParams(fn, args, env, n);
        let result = null;
        if (fn.exprBody) result = this.ev(fn.body, env);
        else {
          const r = this.execIn(fn.body, env);
          if (r instanceof ReturnSignal) result = r.value;
        }
        if (fn.retType) this.checkType(result, fn.retType, `関数 ${fn.name || '(無名)'} の戻り値`, n, env);
        return result;
      } catch (e) {
        if ((e instanceof PreError || e instanceof PreThrow) && e.trace.length < 25) e.trace.push({ fn: fn.name || '(無名)', line: n ? n.line : this.line });
        throw e;
      } finally {
        this.depth--;
      }
    }
    construct(cls, args, n) {
      const inst = new PreInstance(cls);
      const chain = [];
      for (let c = cls; c; c = c.parent) chain.unshift(c);
      for (const c of chain) {
        for (const f of c.fields) {
          const fe = new Env(c.env);
          fe.vars.set('this', inst);
          const v = f.init ? this.ev(f.init, fe) : null;
          inst.props.set(f.name, v);
        }
      }
      const ctor = cls.findMethod('constructor');
      if (ctor) this.callFn(ctor, args, inst, n);
      else if (args.length) this.fail('TypeError', `クラス ${cls.name} にはコンストラクタがないので、引数は渡せません`, n);
      // 型付きフィールドは、コンストラクタが値を入れ終わってから検査する
      for (const c of chain) {
        for (const f of c.fields) {
          if (f.type) this.checkType(inst.props.get(f.name), f.type, `フィールド '${f.name}'`, f, c.env);
        }
      }
      return inst;
    }
    homeOf(env) { for (let e = env; e; e = e.parent) if (e.home) return e.home; return null; }
    thisOf(env, n) {
      for (let e = env; e; e = e.parent) { const v = e.vars.get('this'); if (v !== undefined) return v; }
      this.fail('NameError', "'this' はクラスのメソッドの中でだけ使えます", n);
    }
    superMember(name, env, n) {
      const home = this.homeOf(env);
      if (!home || !home.parent) this.fail('TypeError', "親クラスがないので 'super' は使えません", n);
      const m = home.parent.findMethod(name);
      if (!m) this.fail('AttributeError', `親クラス ${home.parent.name} に '${name}' はありません`, n);
      return new BoundMethod(m, this.thisOf(env, n));
    }
    superCall(n, env) {
      const home = this.homeOf(env);
      if (!home || !home.parent) this.fail('TypeError', "親クラスがないので 'super(...)' は使えません", n);
      const args = this.evArgs(n.args, env);
      const ctor = home.parent.findMethod('constructor');
      if (ctor) this.callFn(ctor, args, this.thisOf(env, n), n);
      else if (args.length) this.fail('TypeError', `親クラス ${home.parent.name} にはコンストラクタがないので、引数は渡せません`, n);
      return null;
    }
    evArgs(list, env) {
      const out = [];
      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (a.t === 'Spread') { const it = this.toIterable(this.ev(a.arg, env), a); for (let k = 0; k < it.length; k++) out.push(it[k]); }
        else out.push(this.ev(a, env));
      }
      return out;
    }

    makeFn(n, env) {
      return new PreFunction(n.name, n.params, n.body, env, n.exprBody, n.retType, n.minArgs, n.maxArgs);
    }
    hoist(b, env) { for (const f of b.fns) env.define(f.name, this.makeFn(f, env)); }
    declClass(n, env) {
      let parent = null;
      if (n.superName) {
        parent = this.lookup(n.superName, env, n);
        if (!(parent instanceof PreClass)) this.fail('TypeError', `'${n.superName}' はクラスではないので継承できません`, n);
      }
      const cls = new PreClass(n.name, parent, env);
      for (const m of n.methods) { const fn = this.makeFn(m, env); fn.home = cls; cls.methods.set(m.name, fn); }
      cls.fields = n.fields;
      this.declare(env, n.name, cls, false, n);
    }

    /* ── 文の実行 ── */
    execIn(b, env) {
      if (b.fns) this.hoist(b, env);
      const body = b.body;
      for (let i = 0; i < body.length; i++) { const r = this.exec(body[i], env); if (r !== undefined) return r; }
      return undefined;
    }
    execScope(b, env) {
      if (b.needsScope) { env = new Env(env); if (b.fns) this.hoist(b, env); }
      const body = b.body;
      for (let i = 0; i < body.length; i++) { const r = this.exec(body[i], env); if (r !== undefined) return r; }
      return undefined;
    }
    exec(n, env) {
      this.line = n.line;
      switch (n.t) {
        case 'Expr': this.ev(n.expr, env); return undefined;
        case 'Let': this.execLet(n, env); return undefined;
        case 'Seq': this.execSeq(n, env); return undefined;
        case 'FnDecl': return undefined;
        case 'ClassDecl': this.declClass(n, env); return undefined;
        case 'Block': return this.execScope(n, env);
        case 'If': return this.execIf(n, env);
        case 'While': return this.execWhile(n, env);
        case 'ForC': return this.execForC(n, env);
        case 'ForIn': return this.execForIn(n, env);
        case 'Return': return new ReturnSignal(n.arg ? this.ev(n.arg, env) : null);
        case 'Break': return BREAK;
        case 'Continue': return CONTINUE;
        case 'Throw': throw new PreThrow(this.ev(n.arg, env), n.line);
        case 'Try': return this.execTry(n, env);
        case 'Match': return this.execMatch(n, env, true);
        default: this.fail('InternalError', `未対応の文: ${n.t}`, n);
      }
      return undefined;
    }
    execLet(n, env) {
      const v = n.init ? this.ev(n.init, env) : null;
      if (n.type && n.init) this.checkType(v, n.type, n.target.t === 'PId' ? `変数 '${n.target.name}'` : '値', n, env);
      if (v instanceof PreFunction && !v.name && n.target.t === 'PId') v.name = n.target.name;
      this.bind(n.target, v, env, n.kind, n);
    }
    execSeq(n, env) { for (let i = 0; i < n.body.length; i++) this.exec(n.body[i], env); }
    execIf(n, env) {
      if (this.truthy(this.ev(n.cond, env))) return this.execScope(n.then, env);
      if (n.else) return n.else.t === 'If' ? this.exec(n.else, env) : this.execScope(n.else, env);
      return undefined;
    }
    execWhile(n, env) {
      while (this.truthy(this.ev(n.cond, env))) {
        this.tick();
        const r = this.execScope(n.body, env);
        if (r !== undefined) { if (r === BREAK) break; if (r === CONTINUE) continue; return r; }
      }
      return undefined;
    }
    execForC(n, env) {
      const le = new Env(env);
      if (n.init) this.exec(n.init, le);
      while (!n.cond || this.truthy(this.ev(n.cond, le))) {
        this.tick();
        const r = this.execScope(n.body, le);
        if (r !== undefined && r !== CONTINUE) { if (r === BREAK) break; return r; }
        if (n.update) this.ev(n.update, le);
      }
      return undefined;
    }
    execForIn(n, env) {
      const items = this.toIterable(this.ev(n.iter, env), n.iter);
      for (let i = 0; i < items.length; i++) {
        this.tick();
        const e = new Env(env);
        this.bind(n.pat, items[i], e, 'let', n);
        const r = this.execIn(n.body, e);
        if (r !== undefined) { if (r === BREAK) break; if (r === CONTINUE) continue; return r; }
      }
      return undefined;
    }
    execTry(n, env) {
      let result, pending = null;
      try { result = this.execScope(n.block, env); }
      catch (e) {
        if (n.handler && this.catchable(e)) {
          try {
            const he = new Env(env);
            if (n.param) he.define(n.param, this.errorValue(e));
            result = this.execIn(n.handler, he);
          } catch (e2) { pending = e2; }
        } else pending = e;
      }
      if (n.finalizer) { const fr = this.execScope(n.finalizer, env); if (fr !== undefined) return fr; }
      if (pending) throw pending;
      return result;
    }
    catchable(e) {
      if (e instanceof PreThrow) return true;
      if (e instanceof PreError) return !e.fatal;
      return e instanceof RangeError && /call stack/i.test(e.message);
    }
    errorValue(e) {
      if (e instanceof PreThrow) return e.value;
      let kind, msg, line = null;
      if (e instanceof PreError) { kind = e.kind; msg = e.message; line = e.line; }
      else { kind = 'RecursionError'; msg = '再帰が深すぎます'; }
      const cls = this.builtins.vars.get(kind);
      let inst;
      if (cls instanceof PreClass) inst = this.construct(cls, [msg], null);
      else { inst = this.construct(this.builtins.vars.get('Error'), [msg], null); inst.props.set('name', kind); }
      if (line != null) inst.props.set('line', line);
      return inst;
    }

    /* ── 式の評価 ── */
    ev(n, env) {
      switch (n.t) {
        case 'Lit': return n.v;
        case 'Id': return this.lookup(n.name, env, n);
        case 'Call': return this.evCall(n, env);
        case 'Binary': return this.evBinary(n, env);
        case 'Cond': return this.truthy(this.ev(n.test, env)) ? this.ev(n.a, env) : this.ev(n.b, env);
        case 'Compare': return this.evCompare(n, env);
        case 'Logical': return this.evLogical(n, env);
        case 'Member': return this.evMember(n, env);
        case 'Index': return this.evIndex(n, env);
        case 'Assign': return this.evAssign(n, env);
        case 'Update': return this.evUpdate(n, env);
        case 'Tpl': return this.evTpl(n, env);
        case 'This': return this.thisOf(env, n);
        case 'List': return this.evList(n, env);
        case 'ListComp': return this.evComp(n, env);
        case 'Map': return this.evMap(n, env);
        case 'Fn': return this.makeFn(n, env);
        case 'Unary': return this.evUnary(n, env);
        case 'Slice': return this.evSlice(n, env);
        case 'Chain': return this.evChain(n, env);
        case 'Pipe': return this.evPipe(n, env);
        case 'Match': return this.execMatch(n, env, false);
        case 'Fmt': return this.format(this.ev(n.expr, env), n.spec, n);
        case 'Super': return this.fail('SyntaxError', "'super' の後には ( か .メソッド名 が必要です", n);
        default: return this.fail('InternalError', `未対応の式: ${n.t}`, n);
      }
    }
    evChain(n, env) { const r = this.ev(n.expr, env); return r === SHORT ? null : r; }
    evTpl(n, env) {
      let s = '';
      const ps = n.parts;
      for (let i = 0; i < ps.length; i++) { const p = ps[i]; s += typeof p === 'string' ? p : this.toStr(this.ev(p, env)); }
      return s;
    }
    evList(n, env) {
      const out = [];
      for (const it of n.items) {
        if (it.t === 'Spread') { const arr = this.toIterable(this.ev(it.arg, env), it); for (let k = 0; k < arr.length; k++) out.push(arr[k]); }
        else out.push(this.ev(it, env));
      }
      return out;
    }
    evComp(n, env) { const out = []; this.comp(n, 0, env, out); return out; }
    evMap(n, env) {
      const m = new Map();
      for (const en of n.entries) {
        if (en.spread) {
          const s = this.ev(en.spread, env);
          if (s instanceof Map) for (const [k, v] of s) m.set(k, v);
          else if (s instanceof PreInstance) for (const [k, v] of s.props) m.set(k, v);
          else this.fail('TypeError', `${typeName(s)} はマップに展開できません`, n);
        } else m.set(en.computed ? this.ev(en.key, env) : en.key, this.ev(en.value, env));
      }
      return m;
    }
    evUnary(n, env) {
      const v = this.ev(n.arg, env);
      if (n.op === 'not') return !this.truthy(v);
      if (typeof v !== 'number') this.fail('TypeError', `単項 '${n.op}' は number にしか使えません (${typeName(v)})`, n);
      switch (n.op) { case '-': return -v; case '+': return v; default: return ~v; }
    }
    evBinary(n, env) {
      const a = this.ev(n.l, env), b = this.ev(n.r, env);
      if (typeof a === 'number' && typeof b === 'number') {
        switch (n.op) { case '+': return a + b; case '-': return a - b; case '*': return a * b; default: break; }
      }
      return this.binop(n.op, a, b, n);
    }
    evLogical(n, env) {
      const l = this.ev(n.l, env);
      if (n.op === '&&') return this.truthy(l) ? this.ev(n.r, env) : l;
      if (n.op === '||') return this.truthy(l) ? l : this.ev(n.r, env);
      return l !== null && l !== undefined ? l : this.ev(n.r, env);
    }
    evCompare(n, env) {
      let left = this.ev(n.operands[0], env);
      for (let k = 0; k < n.ops.length; k++) {
        const right = this.ev(n.operands[k + 1], env);
        if (!this.cmpOp(n.ops[k], left, right, n)) return false;
        left = right;
      }
      return true;
    }
    evMember(n, env) {
      if (n.obj.t === 'Super') return this.superMember(n.prop, env, n);
      const o = this.ev(n.obj, env);
      if (o === SHORT) return SHORT;
      if (n.optional && (o === null || o === undefined)) return SHORT;
      return this.getMember(o, n.prop, n);
    }
    evIndex(n, env) {
      const o = this.ev(n.obj, env);
      if (o === SHORT) return SHORT;
      if (n.optional && (o === null || o === undefined)) return SHORT;
      return this.getIndex(o, this.ev(n.index, env), n);
    }
    evSlice(n, env) {
      const o = this.ev(n.obj, env);
      if (o === SHORT) return SHORT;
      if (n.optional && (o === null || o === undefined)) return SHORT;
      const s = n.start ? this.ev(n.start, env) : null, e = n.end ? this.ev(n.end, env) : null;
      if (Array.isArray(o) || typeof o === 'string') { const [a, b] = this.sliceBounds(o.length, s, e, n); return o.slice(a, b); }
      return this.fail('TypeError', `${typeName(o)} はスライスできません`, n);
    }
    evCall(n, env) {
      this.line = n.line;
      const c = n.callee;
      if (c.t === 'Super') return this.superCall(n, env);
      let f;
      if (c.t === 'Member') {
        if (c.obj.t === 'Super') f = this.superMember(c.prop, env, c);
        else {
          const o = this.ev(c.obj, env);
          if (o === SHORT) return SHORT;
          if (c.optional && (o === null || o === undefined)) return SHORT;
          f = this.getMember(o, c.prop, c);
        }
      } else f = this.ev(c, env);
      if (f === SHORT) return SHORT;
      if (n.optional && (f === null || f === undefined)) return SHORT;
      const args = this.evArgs(n.args, env);
      this.line = n.line;
      return this.call(f, args, n);
    }
    comp(n, k, env, out) {
      if (k === n.clauses.length) { out.push(this.ev(n.elem, env)); return; }
      const c = n.clauses[k];
      if (c.cond) { if (this.truthy(this.ev(c.cond, env))) this.comp(n, k + 1, env, out); return; }
      const items = this.toIterable(this.ev(c.iter, env), c.iter);
      for (let i = 0; i < items.length; i++) {
        this.tick();
        const e = new Env(env);
        this.bind(c.pat, items[i], e, 'let', n);
        this.comp(n, k + 1, e, out);
      }
    }
    evAssign(n, env) {
      const t = n.target;
      if (n.op === '=') {
        if (t.t === 'Id') { const v = this.ev(n.value, env); this.assignVar(t.name, v, env, t); return v; }
        if (t.t === 'Member') { const o = this.ev(t.obj, env); const v = this.ev(n.value, env); this.setMember(o, t.prop, v, t); return v; }
        if (t.t === 'Index') { const o = this.ev(t.obj, env); const i = this.ev(t.index, env); const v = this.ev(n.value, env); this.setIndex(o, i, v, t); return v; }
        const v = this.ev(n.value, env);
        this.bind(t.pattern, v, env, 'assign', n);
        return v;
      }
      const op = n.op.slice(0, -1);
      if (t.t === 'Id') {
        const cur = this.lookup(t.name, env, t);
        const v = this.binop(op, cur, this.ev(n.value, env), n);
        this.assignVar(t.name, v, env, t);
        return v;
      }
      if (t.t === 'Member') {
        const o = this.ev(t.obj, env);
        const v = this.binop(op, this.getMember(o, t.prop, t), this.ev(n.value, env), n);
        this.setMember(o, t.prop, v, t);
        return v;
      }
      const o = this.ev(t.obj, env), i = this.ev(t.index, env);
      const v = this.binop(op, this.getIndex(o, i, t), this.ev(n.value, env), n);
      this.setIndex(o, i, v, t);
      return v;
    }
    evUpdate(n, env) {
      const t = n.target;
      const d = n.op === '++' ? 1 : -1;
      const chk = (x) => { if (typeof x !== 'number') this.fail('TypeError', `'${n.op}' は number にしか使えません (${typeName(x)})`, n); };
      let old, o, i;
      if (t.t === 'Id') old = this.lookup(t.name, env, t);
      else if (t.t === 'Member') { o = this.ev(t.obj, env); old = this.getMember(o, t.prop, t); }
      else { o = this.ev(t.obj, env); i = this.ev(t.index, env); old = this.getIndex(o, i, t); }
      chk(old);
      const nv = old + d;
      if (t.t === 'Id') this.assignVar(t.name, nv, env, t);
      else if (t.t === 'Member') this.setMember(o, t.prop, nv, t);
      else this.setIndex(o, i, nv, t);
      return n.prefix ? nv : old;
    }

    /* ── パイプ演算子 a |> f / a |> f(x) (左の値を第1引数にして呼ぶ) ── */
    evPipe(n, env) {
      const v = this.ev(n.l, env);
      const r = n.r;
      if (r.t === 'Call' && r.callee.t !== 'Super') {
        const c = r.callee;
        let f;
        if (c.t === 'Member') f = this.getMember(this.ev(c.obj, env), c.prop, c);
        else f = this.ev(c, env);
        const args = [v].concat(this.evArgs(r.args, env));
        this.line = r.line;
        return this.call(f, args, r);
      }
      const f = this.ev(r, env);
      this.line = n.line;
      return this.call(f, [v], n);
    }

    /* ── match ── */
    execMatch(n, env, stmt) {
      const v = this.ev(n.subject, env);
      for (let i = 0; i < n.arms.length; i++) {
        const arm = n.arms[i];
        const ae = new Env(env);
        if (!this.matchPat(arm.pat, v, ae)) continue;
        if (arm.guard && !this.truthy(this.ev(arm.guard, ae))) continue;
        this.line = arm.line;
        if (stmt) {
          if (arm.kind === 'expr') { this.ev(arm.node, ae); return undefined; }
          if (arm.kind === 'block') return this.execIn(arm.node, ae);
          return this.exec(arm.node, ae);
        }
        if (arm.kind === 'expr') return this.ev(arm.node, ae);
        if (arm.kind === 'block') return this.blockValue(arm.node, ae);
        const r = this.exec(arm.node, ae);
        if (r !== undefined) this.fail('SyntaxError', '値として使う match の中では return / break / continue は使えません', arm);
        return null;
      }
      if (stmt) return undefined;
      return this.fail('ValueError', `match に一致するパターンがありません: ${this.short(v)} (最後に _ => ... を足すと「それ以外」を扱えます)`, n);
    }
    blockValue(b, env) {
      if (b.fns) this.hoist(b, env);
      const body = b.body;
      let val = null;
      for (let i = 0; i < body.length; i++) {
        const s = body[i];
        if (i === body.length - 1 && s.t === 'Expr') { this.line = s.line; val = this.ev(s.expr, env); }
        else {
          const r = this.exec(s, env);
          if (r !== undefined) this.fail('SyntaxError', '値として使う { } の中では return / break / continue は使えません', s);
        }
      }
      return val;
    }
    matchPat(p, v, env) {
      switch (p.t) {
        case 'MWild': return true;
        case 'MBind': env.define(p.name, v); return true;
        case 'MLit': return this.eq(v, p.v);
        case 'MOr':
          for (let i = 0; i < p.alts.length; i++) if (this.matchPat(p.alts[i], v, env)) return true;
          return false;
        case 'MIs':
          if (!this.matches(v, p.type, env)) return false;
          if (p.name) env.define(p.name, v);
          return true;
        case 'MList': {
          if (!Array.isArray(v)) return false;
          if (p.rest ? v.length < p.items.length : v.length !== p.items.length) return false;
          for (let i = 0; i < p.items.length; i++) if (!this.matchPat(p.items[i], v[i], env)) return false;
          if (p.rest) this.matchPat(p.rest, v.slice(p.items.length), env);
          return true;
        }
        case 'MMap': {
          let src;
          if (v instanceof Map) src = v;
          else if (v instanceof PreInstance) src = v.props;
          else return false;
          const used = new Set();
          for (const pr of p.props) {
            if (!src.has(pr.key)) return false;
            used.add(pr.key);
            if (!this.matchPat(pr.pat, src.get(pr.key), env)) return false;
          }
          if (p.rest) {
            const m = new Map();
            for (const [k, x] of src) if (!used.has(k)) m.set(k, x);
            this.matchPat(p.rest, m, env);
          }
          return true;
        }
        default: return false;
      }
    }

    /* ── f"{x:.2f}" の書式指定 ([[fill]align][sign][0][width][,][.prec][type]) ── */
    format(v, spec, n) {
      const m = /^(?:(.)?([<>^]))?([+\- ])?(0)?(\d+)?(,)?(?:\.(\d+))?([dfFeEgGsxXbo%])?$/u.exec(spec);
      if (!m) this.fail('ValueError', `書式 ':${spec}' が正しくありません (例: .2f / 05d / >8 / ^10 / ,)`, n);
      const [, fillCh, align0, sign, zero, widthS, comma, precS, type] = m;
      const width = widthS ? parseInt(widthS, 10) : 0;
      const prec = precS !== undefined ? parseInt(precS, 10) : null;
      let body, numeric = false;
      if (typeof v === 'number') {
        numeric = true;
        const neg = v < 0 || Object.is(v, -0);
        const a = Math.abs(v);
        switch (type) {
          case 'd': if (!Number.isInteger(v)) this.fail('ValueError', "書式 'd' は整数にだけ使えます (小数には f を使います)", n); body = String(a); break;
          case 'f': case 'F': body = a.toFixed(prec === null ? 6 : prec); break;
          case 'e': case 'E': { body = a.toExponential(prec === null ? 6 : prec).replace(/e([+-])(\d)$/, (_, sg2, d) => 'e' + sg2 + '0' + d); if (type === 'E') body = body.toUpperCase(); break; }
          case 'g': case 'G': body = prec === null ? fmtNum(a) : String(Number(a.toPrecision(prec || 1))); break;
          case '%': body = (a * 100).toFixed(prec === null ? 6 : prec) + '%'; break;
          case 'x': body = Math.trunc(a).toString(16); break;
          case 'X': body = Math.trunc(a).toString(16).toUpperCase(); break;
          case 'o': body = Math.trunc(a).toString(8); break;
          case 'b': body = Math.trunc(a).toString(2); break;
          case 's': this.fail('ValueError', "書式 's' は数値には使えません", n); break;
          default: body = prec === null ? fmtNum(a) : a.toFixed(prec);
        }
        if (comma) { const parts = body.split('.'); parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ','); body = parts.join('.'); }
        const sg = neg ? '-' : (sign === '+' ? '+' : sign === ' ' ? ' ' : '');
        if (zero && width && !align0) {
          const pad = Math.max(0, width - sg.length - body.length);
          return sg + '0'.repeat(pad) + body;
        }
        body = sg + body;
      } else {
        if (type && type !== 's') this.fail('ValueError', `書式 '${type}' は数値にだけ使えます (${typeName(v)} が渡されました)`, n);
        body = this.toStr(v);
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
  }

  /* ═════════════ 標準ライブラリ ═════════════ */
  function installBuiltins(I) {
    const fail = (k, m) => I.fail(k, m);
    const num = (v, what) => { if (typeof v !== 'number') fail('TypeError', `${what} には数値が必要です (${typeName(v)} が渡されました)`); return v; };
    const str = (v, what) => { if (typeof v !== 'string') fail('TypeError', `${what} には文字列が必要です (${typeName(v)} が渡されました)`); return v; };
    const lst = (v, what) => { if (!Array.isArray(v)) fail('TypeError', `${what} にはリストが必要です (${typeName(v)} が渡されました)`); return v; };
    const fnc = (v, what) => {
      if (!(typeof v === 'function' || v instanceof PreFunction || v instanceof BoundMethod)) fail('TypeError', `${what} には関数が必要です (${typeName(v)} が渡されました)`);
      return v;
    };
    const sliceOf = (x, a, b) => {
      const [s, e] = I.sliceBounds(x.length, a === undefined ? null : a, b === undefined ? null : b, null);
      return x.slice(s, e);
    };

    /* 文字列 */
    const STR = {
      upper: (s) => s.toUpperCase(), toUpperCase: (s) => s.toUpperCase(),
      lower: (s) => s.toLowerCase(), toLowerCase: (s) => s.toLowerCase(),
      trim: (s) => s.trim(), trimStart: (s) => s.trimStart(), trimEnd: (s) => s.trimEnd(),
      split: (s, sep) => (sep === undefined || sep === null ? s.split(/\s+/).filter((x) => x !== '') : s.split(str(sep, 'split の区切り'))),
      replace: (s, a, b) => s.split(str(a, 'replace の検索文字列')).join(str(b, 'replace の置換文字列')),
      replaceFirst: (s, a, b) => s.replace(str(a, 'replaceFirst'), () => str(b, 'replaceFirst')),
      startsWith: (s, x) => s.startsWith(str(x, 'startsWith')),
      endsWith: (s, x) => s.endsWith(str(x, 'endsWith')),
      includes: (s, x) => s.includes(str(x, 'includes')), contains: (s, x) => s.includes(str(x, 'contains')),
      indexOf: (s, x) => s.indexOf(str(x, 'indexOf')), lastIndexOf: (s, x) => s.lastIndexOf(str(x, 'lastIndexOf')),
      slice: (s, a, b) => sliceOf(s, a, b), substring: (s, a, b) => sliceOf(s, a, b),
      charAt: (s, i) => s[I.normIndex(s.length, i)],
      repeat: (s, k) => I.repeat(s, k),
      padStart: (s, k, p) => s.padStart(num(k, 'padStart'), p === undefined ? ' ' : p),
      padEnd: (s, k, p) => s.padEnd(num(k, 'padEnd'), p === undefined ? ' ' : p),
      chars: (s) => Array.from(s),
      lines: (s) => s.split(/\r?\n/),
      capitalize: (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase(),
      count: (s, x) => (str(x, 'count') === '' ? s.length + 1 : s.split(x).length - 1),
      isDigit: (s) => /^[0-9]+$/.test(s),
      isAlpha: (s) => /^\p{L}+$/u.test(s),
      isSpace: (s) => /^\s+$/.test(s),
      toString: (s) => s,
    };

    /* リスト */
    const LIST = {
      push: (a, ...xs) => { for (const x of xs) a.push(x); return null; },
      append: (a, ...xs) => { for (const x of xs) a.push(x); return null; },
      pop: (a, i) => {
        if (!a.length) fail('IndexError', '空のリストから pop できません');
        if (i === undefined) return a.pop();
        return a.splice(I.normIndex(a.length, i), 1)[0];
      },
      shift: (a) => { if (!a.length) fail('IndexError', '空のリストから shift できません'); return a.shift(); },
      unshift: (a, ...xs) => { a.unshift(...xs); return null; },
      insert: (a, i, x) => { num(i, 'insert の位置'); let k = i < 0 ? i + a.length : i; k = Math.max(0, Math.min(a.length, k)); a.splice(k, 0, x); return null; },
      remove: (a, x) => {
        const k = a.findIndex((y) => I.eq(x, y));
        if (k < 0) fail('ValueError', `${I.short(x)} はリストの中にありません`);
        a.splice(k, 1); return null;
      },
      indexOf: (a, x) => a.findIndex((y) => I.eq(x, y)),
      includes: (a, x) => a.some((y) => I.eq(x, y)), contains: (a, x) => a.some((y) => I.eq(x, y)),
      join: (a, sep) => a.map((x) => I.toStr(x)).join(sep === undefined ? ',' : str(sep, 'join の区切り')),
      reverse: (a) => { a.reverse(); return a; },
      sort: (a, f) => { I.sortInPlace(a, f); return a; },
      map: (a, f) => { fnc(f, 'map'); const out = []; for (let i = 0; i < a.length; i++) out.push(I.callCb(f, a[i], i, a)); return out; },
      filter: (a, f) => { fnc(f, 'filter'); const out = []; for (let i = 0; i < a.length; i++) if (I.truthy(I.callCb(f, a[i], i, a))) out.push(a[i]); return out; },
      reduce: (a, f, init) => {
        fnc(f, 'reduce');
        let acc, i = 0;
        if (init === undefined) { if (!a.length) fail('TypeError', '空のリストを初期値なしで reduce できません'); acc = a[0]; i = 1; } else acc = init;
        for (; i < a.length; i++) acc = I.callCb(f, acc, a[i], i);
        return acc;
      },
      forEach: (a, f) => { fnc(f, 'forEach'); for (let i = 0; i < a.length; i++) I.callCb(f, a[i], i, a); return null; },
      each: (a, f) => { fnc(f, 'each'); for (let i = 0; i < a.length; i++) I.callCb(f, a[i], i, a); return null; },
      find: (a, f) => { fnc(f, 'find'); for (let i = 0; i < a.length; i++) if (I.truthy(I.callCb(f, a[i], i, a))) return a[i]; return null; },
      findIndex: (a, f) => { fnc(f, 'findIndex'); for (let i = 0; i < a.length; i++) if (I.truthy(I.callCb(f, a[i], i, a))) return i; return -1; },
      some: (a, f) => { fnc(f, 'some'); for (let i = 0; i < a.length; i++) if (I.truthy(I.callCb(f, a[i], i, a))) return true; return false; },
      any: (a, f) => { fnc(f, 'any'); for (let i = 0; i < a.length; i++) if (I.truthy(I.callCb(f, a[i], i, a))) return true; return false; },
      every: (a, f) => { fnc(f, 'every'); for (let i = 0; i < a.length; i++) if (!I.truthy(I.callCb(f, a[i], i, a))) return false; return true; },
      all: (a, f) => { fnc(f, 'all'); for (let i = 0; i < a.length; i++) if (!I.truthy(I.callCb(f, a[i], i, a))) return false; return true; },
      slice: (a, s, e) => sliceOf(a, s, e),
      concat: (a, ...ls) => { let out = a.slice(); for (const l of ls) out = out.concat(Array.isArray(l) ? l : [l]); return out; },
      flat: (a) => { const out = []; for (const x of a) { if (Array.isArray(x)) out.push(...x); else out.push(x); } return out; },
      fill: (a, x) => { a.fill(x); return a; },
      sum: (a) => { let s = 0; for (const x of a) s += num(x, 'sum の要素'); return s; },
      min: (a) => { if (!a.length) fail('ValueError', '空のリストの最小値は求められません'); return a.reduce((m, x) => (I.cmp(x, m) < 0 ? x : m)); },
      max: (a) => { if (!a.length) fail('ValueError', '空のリストの最大値は求められません'); return a.reduce((m, x) => (I.cmp(x, m) > 0 ? x : m)); },
      count: (a, x) => a.filter((y) => I.eq(x, y)).length,
      clear: (a) => { a.length = 0; return null; },
      copy: (a) => a.slice(),
      first: (a) => (a.length ? a[0] : null),
      last: (a) => (a.length ? a[a.length - 1] : null),
      unique: (a) => { const out = []; for (const x of a) if (!out.some((y) => I.eq(x, y))) out.push(x); return out; },
      toString: (a) => I.repr(a, 0, []),
    };

    /* マップ */
    const MAP = {
      keys: (m) => Array.from(m.keys()),
      values: (m) => Array.from(m.values()),
      items: (m) => Array.from(m.entries()).map(([k, v]) => [k, v]),
      has: (m, k) => m.has(k),
      get: (m, k, d) => (m.has(k) ? m.get(k) : d === undefined ? null : d),
      set: (m, k, v) => { m.set(k, v); return m; },
      delete: (m, k) => m.delete(k), remove: (m, k) => m.delete(k),
      clear: (m) => { m.clear(); return null; },
      copy: (m) => new Map(m),
      merge: (m, o) => { const out = new Map(m); if (!(o instanceof Map)) fail('TypeError', 'merge にはマップが必要です'); for (const [k, v] of o) out.set(k, v); return out; },
    };

    const NUM = {
      toFixed: (x, d) => x.toFixed(d === undefined ? 0 : num(d, 'toFixed')),
      toString: (x) => fmtNum(x),
    };
    I.lib = { STR, LIST, MAP, NUM };

    I.sortInPlace = function (a, f) {
      if (f === undefined || f === null) a.sort((x, y) => I.cmp(x, y));
      else {
        fnc(f, 'sort');
        if (I.arityOf(f) >= 2) {
          a.sort((x, y) => { const r = I.call(f, [x, y], null); if (typeof r !== 'number') fail('TypeError', 'sort の比較関数は数値を返す必要があります'); return r; });
        } else {
          const keyed = a.map((x) => [I.call(f, [x], null), x]);
          keyed.sort((p, q) => I.cmp(p[0], q[0]));
          for (let i = 0; i < a.length; i++) a[i] = keyed[i][1];
        }
      }
    };

    const def = (name, fn) => { fn.preName = name; I.builtins.define(name, fn, true); };
    const cst = (name, v) => I.builtins.define(name, v, true);
    cst('PI', Math.PI); cst('E', Math.E); cst('INF', Infinity);

    def('print', (...a) => { I.write(a.map((x) => I.toStr(x)).join(' ') + '\n'); return null; });
    def('write', (...a) => { I.write(a.map((x) => I.toStr(x)).join('')); return null; });
    def('input', (prompt) => {
      const p = prompt === undefined ? '' : I.toStr(prompt);
      const r = I.opts.input ? I.opts.input(p) : null;
      if (r === null || r === undefined) fail('EOFError', '入力がありません (「入力」欄に値を書いてから実行してください)');
      return String(r);
    });
    def('len', (x) => {
      if (typeof x === 'string' || Array.isArray(x)) return x.length;
      if (x instanceof Map) return x.size;
      if (x instanceof PreInstance) return x.props.size;
      return fail('TypeError', `${typeName(x)} には len() が使えません`);
    });
    def('range', (a, b, c) => {
      let start = 0, stop, step = 1;
      if (b === undefined) stop = num(a, 'range'); else { start = num(a, 'range'); stop = num(b, 'range'); }
      if (c !== undefined) step = num(c, 'range');
      if (step === 0) fail('ValueError', 'range の step は 0 にできません');
      const count = Math.max(0, Math.ceil((stop - start) / step));
      if (count > 10000000) fail('ValueError', 'range が大きすぎます');
      const out = new Array(count);
      for (let i = 0; i < count; i++) out[i] = start + i * step;
      return out;
    });
    def('str', (x) => I.toStr(x));
    def('num', (x) => {
      if (typeof x === 'number') return x;
      if (typeof x === 'boolean') return x ? 1 : 0;
      if (typeof x === 'string') { const t = x.trim(); const v = t === '' ? NaN : Number(t); if (Number.isNaN(v)) fail('ValueError', `${JSON.stringify(x)} は数値に変換できません`); return v; }
      return fail('ValueError', `${typeName(x)} は数値に変換できません`);
    });
    I.builtins.define('float', I.builtins.vars.get('num'), true);
    def('int', (x) => {
      let v;
      if (typeof x === 'number') v = x;
      else if (typeof x === 'boolean') v = x ? 1 : 0;
      else if (typeof x === 'string') { const t = x.trim(); v = t === '' ? NaN : Number(t); if (Number.isNaN(v)) fail('ValueError', `${JSON.stringify(x)} は整数に変換できません`); }
      else fail('ValueError', `${typeName(x)} は整数に変換できません`);
      if (!Number.isFinite(v)) fail('ValueError', '無限大や NaN は整数にできません');
      return Math.trunc(v);
    });
    def('bool', (x) => I.truthy(x));
    def('type', (x) => typeName(x));
    def('isinstance', (x, c) => {
      if (c instanceof PreClass) return x instanceof PreInstance && x.cls.isSub(c);
      if (typeof c === 'string') return typeName(x) === c;
      return fail('TypeError', 'isinstance の第2引数にはクラスか型名の文字列が必要です');
    });
    def('keys', (x) => {
      if (x instanceof Map) return Array.from(x.keys());
      if (x instanceof PreInstance) return Array.from(x.props.keys());
      if (Array.isArray(x)) return x.map((_, i) => i);
      return fail('TypeError', `${typeName(x)} には keys() が使えません`);
    });
    def('values', (x) => {
      if (x instanceof Map) return Array.from(x.values());
      if (x instanceof PreInstance) return Array.from(x.props.values());
      if (Array.isArray(x)) return x.slice();
      return fail('TypeError', `${typeName(x)} には values() が使えません`);
    });
    def('items', (x) => {
      if (x instanceof Map) return Array.from(x.entries()).map(([k, v]) => [k, v]);
      if (x instanceof PreInstance) return Array.from(x.props.entries()).map(([k, v]) => [k, v]);
      return fail('TypeError', `${typeName(x)} には items() が使えません`);
    });
    def('has', (x, k) => {
      if (x instanceof Map) return x.has(k);
      if (x instanceof PreInstance) return x.props.has(k) || !!x.cls.findMethod(k);
      return I.contains(x, k, null);
    });
    def('sum', (x, start) => { let s = start === undefined ? 0 : start; for (const v of lst(x, 'sum')) s = I.binop('+', s, v, null); return s; });
    const pick = (name, sign) => (...a) => {
      const arr = a.length === 1 && (Array.isArray(a[0]) || typeof a[0] === 'string') ? I.toIterable(a[0]) : a;
      if (!arr.length) fail('ValueError', `${name}() に渡す値がありません`);
      return arr.reduce((m, x) => (I.cmp(x, m) * sign > 0 ? x : m));
    };
    def('min', pick('min', -1)); def('max', pick('max', 1));
    def('abs', (x) => Math.abs(num(x, 'abs')));
    def('round', (x, d) => {
      num(x, 'round');
      if (d === undefined) return Math.round(x);
      const f = Math.pow(10, num(d, 'round'));
      return Math.round((x + Number.EPSILON * Math.sign(x)) * f) / f;
    });
    def('floor', (x) => Math.floor(num(x, 'floor')));
    def('ceil', (x) => Math.ceil(num(x, 'ceil')));
    def('trunc', (x) => Math.trunc(num(x, 'trunc')));
    def('idiv', (a, b) => { num(a, 'idiv'); num(b, 'idiv'); if (b === 0) fail('ZeroDivisionError', '0 では割れません'); return Math.floor(a / b); });
    def('sqrt', (x) => { num(x, 'sqrt'); if (x < 0) fail('ValueError', '負の数の平方根は求められません'); return Math.sqrt(x); });
    def('pow', (a, b) => Math.pow(num(a, 'pow'), num(b, 'pow')));
    for (const nm of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'exp', 'log2', 'log10', 'sign']) def(nm, (x) => Math[nm](num(x, nm)));
    def('atan2', (y, x) => Math.atan2(num(y, 'atan2'), num(x, 'atan2')));
    def('log', (x, b) => {
      num(x, 'log');
      if (x <= 0) fail('ValueError', 'log は正の数にしか使えません');
      return b === undefined ? Math.log(x) : Math.log(x) / Math.log(num(b, 'log'));
    });
    def('gcd', (a, b) => { a = Math.abs(num(a, 'gcd')); b = Math.abs(num(b, 'gcd')); while (b) { [a, b] = [b, a % b]; } return a; });
    def('isNaN', (x) => typeof x === 'number' && Number.isNaN(x));
    def('random', () => Math.random());
    def('randint', (a, b) => { num(a, 'randint'); num(b, 'randint'); return Math.floor(Math.random() * (Math.floor(b) - Math.ceil(a) + 1)) + Math.ceil(a); });
    def('choice', (a) => { lst(a, 'choice'); if (!a.length) fail('IndexError', '空のリストからは選べません'); return a[Math.floor(Math.random() * a.length)]; });
    def('shuffle', (a) => { const out = lst(a, 'shuffle').slice(); for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; } return out; });
    def('sorted', (x, f) => { const a = I.toIterable(x).slice(); I.sortInPlace(a, f); return a; });
    def('reversed', (x) => (typeof x === 'string' ? Array.from(x).reverse().join('') : lst(x, 'reversed').slice().reverse()));
    def('enumerate', (x, s) => { const st = s === undefined ? 0 : num(s, 'enumerate'); return I.toIterable(x).map((v, i) => [i + st, v]); });
    def('zip', (...ls) => {
      const arrs = ls.map((l) => I.toIterable(l));
      const m = arrs.length ? Math.min(...arrs.map((a) => a.length)) : 0;
      const out = [];
      for (let i = 0; i < m; i++) out.push(arrs.map((a) => a[i]));
      return out;
    });
    // map(f, xs) でも map(xs, f) でも書ける (パイプ xs |> map(f) では後者になる)
    const isFn = (v) => typeof v === 'function' || v instanceof PreFunction || v instanceof BoundMethod;
    def('map', (a, b) => (isFn(a) ? LIST.map(I.toIterable(b), a) : LIST.map(I.toIterable(a), b)));
    def('filter', (a, b) => (isFn(a) ? LIST.filter(I.toIterable(b), a) : LIST.filter(I.toIterable(a), b)));
    def('reduce', (a, b, init) => (isFn(a) ? LIST.reduce(I.toIterable(b), a, init) : LIST.reduce(I.toIterable(a), b, init)));
    def('any', (x) => I.toIterable(x).some((v) => I.truthy(v)));
    def('all', (x) => I.toIterable(x).every((v) => I.truthy(v)));
    def('list', (x) => (x === undefined ? [] : I.toIterable(x).slice()));
    def('chr', (x) => String.fromCodePoint(num(x, 'chr')));
    def('ord', (x) => { str(x, 'ord'); if (!x.length) fail('ValueError', 'ord に空文字列は渡せません'); return x.codePointAt(0); });
    def('clock', () => now() / 1000);
    def('time', () => Date.now() / 1000);
    def('assert', (c, m) => {
      if (!I.truthy(c)) {
        const cls = I.builtins.vars.get('AssertionError');
        throw new PreThrow(I.construct(cls, [m === undefined ? '条件が成り立ちませんでした' : I.toStr(m)], null), I.line);
      }
      return null;
    });
    const copyDeep = (v, deep) => {
      if (Array.isArray(v)) return v.map((x) => (deep ? copyDeep(x, true) : x));
      if (v instanceof Map) { const m = new Map(); for (const [k, x] of v) m.set(k, deep ? copyDeep(x, true) : x); return m; }
      if (v instanceof PreInstance) { const c = new PreInstance(v.cls); for (const [k, x] of v.props) c.props.set(k, deep ? copyDeep(x, true) : x); return c; }
      return v;
    };
    def('copy', (x) => copyDeep(x, false));
    def('clone', (x) => copyDeep(x, true));
    const toJs = (v) => {
      if (v === null || v === undefined) return null;
      if (Array.isArray(v)) return v.map(toJs);
      if (v instanceof Map) { const o = {}; for (const [k, x] of v) o[String(k)] = toJs(x); return o; }
      if (v instanceof PreInstance) { const o = {}; for (const [k, x] of v.props) o[k] = toJs(x); return o; }
      if (typeof v === 'number' && !Number.isFinite(v)) return null;
      if (typeof v === 'object' || typeof v === 'function') return null;
      return v;
    };
    const fromJs = (v) => {
      if (v === null || v === undefined) return null;
      if (Array.isArray(v)) return v.map(fromJs);
      if (typeof v === 'object') { const m = new Map(); for (const k of Object.keys(v)) m.set(k, fromJs(v[k])); return m; }
      return v;
    };
    def('toJson', (x, indent) => JSON.stringify(toJs(x), null, indent === undefined ? undefined : num(indent, 'toJson')));
    def('fromJson', (s) => { try { return fromJs(JSON.parse(str(s, 'fromJson'))); } catch (e) { if (e instanceof PreError) throw e; return fail('ValueError', 'JSON として読み取れません: ' + e.message); } });
    /* JavaScript 風の名前空間: console / Math / JSON */
    const ns = (obj) => { const m = new Map(); for (const k of Object.keys(obj)) m.set(k, obj[k]); return m; };
    const B = (name) => I.builtins.vars.get(name);
    const printFn = B('print');
    cst('console', ns({ log: printFn, info: printFn, warn: printFn, error: printFn, debug: printFn }));
    const mathFns = {};
    for (const nm of ['abs', 'floor', 'ceil', 'round', 'trunc', 'sqrt', 'pow', 'sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'exp', 'log', 'log2', 'log10', 'sign', 'min', 'max', 'random']) mathFns[nm] = B(nm);
    const hypot = (...a) => Math.sqrt(a.reduce((s, x) => s + num(x, 'hypot') ** 2, 0)); hypot.preName = 'hypot'; mathFns.hypot = hypot;
    const cbrt = (x) => Math.cbrt(num(x, 'cbrt')); cbrt.preName = 'cbrt'; mathFns.cbrt = cbrt;
    cst('Math', ns(Object.assign({ PI: Math.PI, E: Math.E }, mathFns)));
    const jsonStringify = (x, a, b) => B('toJson')(x, typeof b === 'number' ? b : typeof a === 'number' ? a : undefined);
    jsonStringify.preName = 'JSON.stringify';
    cst('JSON', ns({ stringify: jsonStringify, parse: B('fromJson') }));
    if (I.opts.extend) I.opts.extend({ I, def, cst, num, str, lst, fail, typeName });
  }

  /* ═════════════ 公開 API ═════════════ */
  function describeError(e, I) {
    if (e instanceof PreError) return { kind: e.kind, message: e.message, line: e.line, col: e.col, trace: e.trace };
    if (e instanceof PreThrow) {
      const v = e.value;
      let kind = 'UncaughtError', message;
      const errCls = I && I.builtins.vars.get('Error');
      if (I && v instanceof PreInstance && errCls && v.cls.isSub(errCls)) {
        kind = I.toStr(v.props.get('name')); message = I.toStr(v.props.get('message'));
        const ln = v.props.get('line');
        if (typeof ln === 'number') return { kind, message, line: ln, col: null, trace: e.trace };
      } else message = I ? I.display(v) : String(v);
      return { kind, message, line: e.line, col: null, trace: e.trace };
    }
    if (e instanceof RangeError && /call stack/i.test(e.message)) {
      return { kind: 'RecursionError', message: '再帰が深すぎます。終了条件を確認してください', line: I ? I.line : null, col: null, trace: [] };
    }
    return { kind: 'InternalError', message: String((e && e.message) || e), line: I ? I.line : null, col: null, trace: [], stack: e && e.stack };
  }

  function run(src, opts) {
    opts = opts || {};
    let I;
    try {
      I = new Interpreter(opts);
      const ast = parse(String(src));
      I.deadline = now() + I.timeLimit;
      I.execIn(ast, I.global);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: describeError(e, I) };
    }
  }

  class Session {
    constructor(opts) { this.I = new Interpreter(opts); this.I.allowRedeclare = true; }
    eval(src) {
      const I = this.I;
      try {
        const ast = parse(String(src));
        I.deadline = now() + I.timeLimit; I.steps = 0; I.depth = 0; I.outLen = 0;
        if (ast.fns) I.hoist(ast, I.global);
        let value = null, has = false;
        const body = ast.body;
        for (let i = 0; i < body.length; i++) {
          const st = body[i];
          if (i === body.length - 1 && st.t === 'Expr') { I.line = st.line; value = I.ev(st.expr, I.global); has = true; }
          else { const r = I.exec(st, I.global); if (r !== undefined) break; }
        }
        return { ok: true, has: has && value !== null && value !== undefined, text: has ? I.display(value) : '' };
      } catch (e) {
        return { ok: false, error: describeError(e, I) };
      }
    }
  }

  let nameCache = null;
  function builtinNames() {
    if (!nameCache) { const I = new Interpreter({ print: () => {} }); nameCache = Array.from(I.builtins.vars.keys()); }
    return nameCache;
  }

  return {
    version: VERSION,
    run,
    Session,
    parse,
    tokenize,
    builtinNames,
    keywords: Array.from(KEYWORDS).concat(Object.keys(KW_ALIAS)),
  };
});
