'use strict';
// Compiler subset Lua -> bytecode vm_level2.
// Didukung: angka bulat, nama, local, assign, if/else, while, print(...), return,
//           function NAME(p1,...) ... end (fungsi global level atas), pemanggilan NAME(args),
//           operator + - * < ==, not, and, or, kurung.
// Tidak didukung: closure (fungsi tidak bisa membaca local dari luar), table, string, for, repeat, goto.
const V = require('./vm_level2');

const MAX_REG = 250;     // register 254 dipakai sebagai "nil" di RET tanpa nilai
const NIL_REG = 254;

function tokenize(src) {
  const toks = [];
  const re = /\s+|(\d+)|([A-Za-z_]\w*)|(==|<|\+|-|\*|\(|\)|=|,|\[|\]|\{|\}|#)/y;
  let i = 0;
  while (i < src.length) {
    re.lastIndex = i;
    const m = re.exec(src);
    if (!m) {
      if (src[i] === '"' || src[i] === "'") throw new SyntaxError(`string belum didukung di vm2 (posisi ${i})`);
      if (src[i] === '.') throw new SyntaxError(`akses titik (t.x) belum didukung di vm2 (posisi ${i})`);
      if (src[i] === '~') throw new SyntaxError(`operator ~= belum didukung di vm2 (posisi ${i})`);
      throw new SyntaxError(`karakter tidak dikenal di ${i}: ${src[i]}`);
    }
    i = re.lastIndex;
    if (m[1]) toks.push({ t: 'num', v: Number(m[1]) });
    else if (m[2]) {
      const kw = ['local', 'if', 'then', 'else', 'end', 'while', 'do', 'print', 'and', 'or', 'not', 'function', 'return', 'for'];
      toks.push(kw.includes(m[2]) ? { t: m[2] } : { t: 'name', v: m[2] });
    } else if (m[3]) toks.push({ t: m[3] });
  }
  toks.push({ t: 'eof' });
  return toks;
}

function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const eat = (t) => { if (toks[p].t !== t) throw new SyntaxError(`diharapkan ${t}, dapat ${toks[p].t}`); return toks[p++]; };

  function expr() { return orE(); }
  function orE() {
    let l = andE();
    while (peek().t === 'or') { p++; l = { k: 'or', l, r: andE() }; }
    return l;
  }
  function andE() {
    let l = cmp();
    while (peek().t === 'and') { p++; l = { k: 'and', l, r: cmp() }; }
    return l;
  }
  function cmp() {
    let l = add();
    if (peek().t === '<') { p++; l = { k: 'bin', op: 'LT', l, r: add() }; }
    else if (peek().t === '==') { p++; l = { k: 'bin', op: 'EQ', l, r: add() }; }
    return l;
  }
  function add() {
    let l = mul();
    while (peek().t === '+' || peek().t === '-') {
      const op = peek().t === '+' ? 'ADD' : 'SUB'; p++;
      l = { k: 'bin', op, l, r: mul() };
    }
    return l;
  }
  function mul() {
    let l = unary();
    while (peek().t === '*') { p++; l = { k: 'bin', op: 'MUL', l, r: unary() }; }
    return l;
  }
  function unary() {
    if (peek().t === 'not') { p++; return { k: 'not', e: unary() }; }
    if (peek().t === '#') { p++; return { k: 'len', e: unary() }; }
    return atom();
  }
  function postfix(node) {
    while (peek().t === '[') {
      p++;
      const key = expr();
      eat(']');
      node = { k: 'index', t: node, key };
    }
    return node;
  }
  function atom() {
    const t = peek();
    if (t.t === 'num') { p++; return { k: 'num', v: t.v }; }
    if (t.t === 'name') {
      p++;
      if (peek().t === '(') {
        p++;
        const args = [];
        if (peek().t !== ')') {
          args.push(expr());
          while (peek().t === ',') { p++; args.push(expr()); }
        }
        eat(')');
        return { k: 'call', name: t.v, args };
      }
      return postfix({ k: 'name', v: t.v });
    }
    if (t.t === '{') {
      p++;
      const items = [];
      if (peek().t !== '}') {
        items.push(expr());
        while (peek().t === ',') { p++; items.push(expr()); }
      }
      eat('}');
      return { k: 'table', items };
    }
    if (t.t === '(') { p++; const e = expr(); eat(')'); return postfix(e); }
    throw new SyntaxError(`ekspresi tidak valid, dapat ${t.t}`);
  }

  function block(stops) {
    const out = [];
    while (!stops.includes(peek().t)) {
      if (peek().t === 'eof') throw new SyntaxError('blok belum ditutup');
      out.push(stmt());
    }
    return out;
  }
  function stmt() {
    const t = peek();
    if (t.t === 'local') { p++; const name = eat('name').v; eat('='); return { k: 'local', name, e: expr() }; }
    if (t.t === 'name' && toks[p + 1].t === '=') { p++; eat('='); return { k: 'assign', name: t.v, e: expr() }; }
    if (t.t === 'name' && toks[p + 1].t === '(') { return { k: 'expr', e: expr() }; }
    if (t.t === 'name' && toks[p + 1].t === '[') {
      p++;
      const keys = [];
      while (peek().t === '[') { p++; keys.push(expr()); eat(']'); }
      eat('=');
      const last = keys.pop();
      let obj = { k: 'name', v: t.v };
      for (const key of keys) obj = { k: 'index', t: obj, key };
      return { k: 'setindex', t: obj, key: last, e: expr() };
    }
    if (t.t === 'print') { p++; eat('('); const e = expr(); eat(')'); return { k: 'print', e }; }
    if (t.t === 'return') { p++; return { k: 'return', e: expr() }; }
    if (t.t === 'if') {
      p++; const c = expr(); eat('then');
      const th = block(['else', 'end']);
      let el = [];
      if (peek().t === 'else') { p++; el = block(['end']); }
      eat('end');
      return { k: 'if', c, th, el };
    }
    if (t.t === 'while') { p++; const c = expr(); eat('do'); const body = block(['end']); eat('end'); return { k: 'while', c, body }; }
    if (t.t === 'for') {
      p++;
      const name = eat('name').v;
      eat('=');
      const start = expr();
      eat(',');
      const limit = expr();
      eat('do');
      const body = block(['end']);
      eat('end');
      return { k: 'for', name, start, limit, body };
    }
    if (t.t === 'function') {
      p++;
      const name = eat('name').v;
      eat('(');
      const params = [];
      if (peek().t !== ')') {
        params.push(eat('name').v);
        while (peek().t === ',') { p++; params.push(eat('name').v); }
      }
      eat(')');
      const body = block(['end']);
      eat('end');
      return { k: 'function', name, params, body };
    }
    // pemanggilan sebagai statement, mis. f(1) sendirian
    if (t.t === 'eof') throw new SyntaxError('unexpected eof');
    throw new SyntaxError(`statement tidak valid, dapat ${t.t}`);
  }

  const ast = block(['eof']);
  eat('eof');
  return ast;
}

function compile(src) {
  const ast = parse(src);
  const code = [];
  const consts = [];
  const funcs = new Map();   // nama -> { idx, nparams }   (global, level atas)
  let scope = new Map();     // nama -> register dalam frame aktif
  let localsTop = 0;
  let tempTop = 0;
  let inFunction = false;

  // dedupe hanya untuk literal. Slot fungsi (alamat awal, jumlah param) tidak pernah dipakai ulang.
  const litIdx = new Map();
  const constIdx = (v) => {
    if (litIdx.has(v)) return litIdx.get(v);
    consts.push(v);
    const i = consts.length - 1;
    if (i > 255) throw new RangeError('konstanta melebihi 255');
    litIdx.set(v, i);
    return i;
  };
  const alloc = () => { const r = tempTop++; if (r > MAX_REG) throw new RangeError('register melebihi batas'); return r; };
  const emit = (op, a = 0, b = 0, c = 0) => { code.push({ op, a, b, c }); return code.length - 1; };

  function expr(e) {
    if (e.k === 'num') { const r = alloc(); emit('LOADK', r, constIdx(e.v)); return r; }
    if (e.k === 'name') {
      if (!scope.has(e.v)) throw new ReferenceError(`nama tidak dikenal: ${e.v}`);
      return scope.get(e.v);
    }
    if (e.k === 'call') {
      const f = funcs.get(e.name);
      if (!f) throw new ReferenceError(`fungsi belum didefinisikan: ${e.name}`);
      if (f.nparams !== e.args.length) throw new TypeError(`jumlah argumen ${e.name} harus ${f.nparams}`);
      const base = tempTop;
      tempTop += e.args.length;
      if (tempTop > MAX_REG) throw new RangeError('register melebihi batas');
      e.args.forEach((arg, i) => {
        const r = expr(arg);
        emit('MOVE', base + i, r);
        tempTop = base + e.args.length;
      });
      const dest = alloc();
      emit('CALL', dest, f.idx, base);
      return dest;
    }
    if (e.k === 'not') { const x = expr(e.e); const d = alloc(); emit('NOT', d, x); return d; }
    if (e.k === 'table') {
      const d = alloc();
      emit('NEWTABLE', d);
      e.items.forEach((item, i) => {
        const mark = tempTop;
        const kr = alloc();
        emit('LOADK', kr, constIdx(i + 1));
        const v = expr(item);
        emit('SET', d, kr, v);
        tempTop = mark;
      });
      return d;
    }
    if (e.k === 'index') {
      const t = expr(e.t);
      const k = expr(e.key);
      const d = alloc();
      emit('GET', d, t, k);
      return d;
    }
    if (e.k === 'len') { const x = expr(e.e); const d = alloc(); emit('LEN', d, x); return d; }
    if (e.k === 'and' || e.k === 'or') {
      const d = alloc();
      const l = expr(e.l);
      emit('MOVE', d, l);
      tempTop = d + 1;
      let jump;
      if (e.k === 'and') {
        jump = emit('JMPF', d, 0);
      } else {
        const n = alloc(); emit('NOT', n, d); jump = emit('JMPF', n, 0);
      }
      const r = expr(e.r);
      emit('MOVE', d, r);
      code[jump].b = code.length;
      tempTop = d + 1;
      return d;
    }
    const l = expr(e.l), r = expr(e.r);
    const d = alloc();
    emit(e.op, d, l, r);
    return d;
  }

  function resetTemps() { tempTop = localsTop; }

  function stmts(list) {
    const savedScope = new Map(scope), savedTop = localsTop;
    for (const s of list) statement(s);
    scope = savedScope; localsTop = savedTop; tempTop = localsTop;
  }

  function statement(s) {
    resetTemps();
    if (s.k === 'local') {
      const r = expr(s.e);
      const reg = localsTop++;
      if (reg > MAX_REG) throw new RangeError('register melebihi batas');
      scope.set(s.name, reg);
      if (r !== reg) emit('MOVE', reg, r);
      tempTop = localsTop;
    } else if (s.k === 'assign') {
      if (!scope.has(s.name)) throw new ReferenceError(`assign ke nama tidak dikenal: ${s.name}`);
      const r = expr(s.e);
      emit('MOVE', scope.get(s.name), r);
    } else if (s.k === 'expr') {
      expr(s.e);
    } else if (s.k === 'setindex') {
      const t = expr(s.t);
      const k = expr(s.key);
      const v = expr(s.e);
      emit('SET', t, k, v);
    } else if (s.k === 'print') {
      emit('PRINT', expr(s.e));
    } else if (s.k === 'return') {
      if (!inFunction) throw new SyntaxError('return hanya boleh di dalam function');
      emit('RET', expr(s.e));
    } else if (s.k === 'if') {
      const c = expr(s.c);
      const jf = emit('JMPF', c, 0);
      tempTop = localsTop;
      stmts(s.th);
      if (s.el.length) {
        const j = emit('JMP', 0, 0);
        code[jf].b = code.length;
        stmts(s.el);
        code[j].b = code.length;
      } else {
        code[jf].b = code.length;
      }
    } else if (s.k === 'while') {
      const start = code.length;
      const c = expr(s.c);
      const jf = emit('JMPF', c, 0);
      tempTop = localsTop;
      stmts(s.body);
      emit('JMP', 0, start);
      code[jf].b = code.length;
    } else if (s.k === 'for') {
      const savedScope = new Map(scope), savedTop = localsTop;
      const hidden = localsTop++;            // penghitung internal
      const limReg = localsTop++;            // batas, dihitung sekali
      if (limReg > MAX_REG) throw new RangeError('register melebihi batas');
      tempTop = localsTop;
      const sr = expr(s.start);
      emit('MOVE', hidden, sr);
      tempTop = localsTop;
      const lr = expr(s.limit);
      emit('MOVE', limReg, lr);
      tempTop = localsTop;
      const one = localsTop++;               // konstanta 1, local tetap supaya body tidak menimpanya
      const varReg = localsTop++;            // variabel yang terlihat di body
      if (varReg > MAX_REG) throw new RangeError('register melebihi batas');
      scope.set(s.name, varReg);
      emit('LOADK', one, constIdx(1));
      tempTop = localsTop;
      const start = code.length;
      const c = alloc();
      emit('LT', c, limReg, hidden);         // batas < penghitung -> selesai
      const n = alloc();
      emit('NOT', n, c);
      const jf = emit('JMPF', n, 0);
      tempTop = localsTop;
      emit('MOVE', varReg, hidden);
      stmts(s.body);
      tempTop = localsTop;
      emit('ADD', hidden, hidden, one);
      emit('JMP', 0, start);
      code[jf].b = code.length;
      scope = savedScope; localsTop = savedTop; tempTop = localsTop;
    } else if (s.k === 'function') {
      if (inFunction) throw new SyntaxError('function di dalam function belum didukung');
      if (funcs.has(s.name)) throw new SyntaxError(`function ${s.name} sudah didefinisikan`);
      // slot konstanta dicadangkan dulu supaya rekursi bisa merujuk dirinya sendiri
      const idx = consts.length;
      consts.push(0, s.params.length);
      if (idx > 255) throw new RangeError('konstanta melebihi 255');
      funcs.set(s.name, { idx, nparams: s.params.length });

      const jskip = emit('JMP', 0, 0);
      const start = code.length;
      const savedScope = scope, savedLocals = localsTop, savedTemp = tempTop, savedIn = inFunction;
      scope = new Map(s.params.map((p, i) => [p, i]));
      localsTop = s.params.length;
      tempTop = localsTop;
      inFunction = true;
      stmts(s.body);
      emit('RET', NIL_REG);    // jatuh ke akhir function tanpa return: kembalikan nil
      scope = savedScope; localsTop = savedLocals; tempTop = savedTemp; inFunction = savedIn;
      consts[idx] = start;
      code[jskip].b = code.length;
    } else {
      throw new SyntaxError(`statement tidak dikenal: ${s.k}`);
    }
  }

  stmts(ast);
  emit('HALT');
  if (code.length > 256) throw new RangeError('program melebihi 256 instruksi');
  return { code, consts };
}

function compileToLua(src, seed) {
  const { code, consts } = compile(src);
  const enc = V.encodeProgram(code.map((c) => ({ op: c.op, a: c.a, b: c.b, c: c.c })), consts, seed);
  return { lua: V.luaString(enc), code, consts };
}

module.exports = { parse, compile, compileToLua };
