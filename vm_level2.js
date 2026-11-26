'use strict';
// VM register level 2 dengan pemanggilan fungsi.
// Opcode diacak dari seed, tiap field instruksi dienkripsi per posisi dengan kunci berputar.
// Lifter (disassemble) membalik proses itu persis.

const OPS = ['LOADK', 'MOVE', 'ADD', 'SUB', 'MUL', 'LT', 'EQ', 'NOT', 'JMPF', 'JMP', 'PRINT', 'CALL', 'RET', 'HALT', 'NEWTABLE', 'GET', 'SET', 'LEN'];
const FIELDS = {
  LOADK: ['a', 'b'], MOVE: ['a', 'b'], ADD: ['a', 'b', 'c'], SUB: ['a', 'b', 'c'],
  MUL: ['a', 'b', 'c'], LT: ['a', 'b', 'c'], EQ: ['a', 'b', 'c'], NOT: ['a', 'b'],
  JMPF: ['a', 'b'], JMP: ['b'], PRINT: ['a'],
  CALL: ['a', 'b', 'c'],  // a: register hasil, b: indeks konstanta (start, jumlah arg), c: register argumen pertama
  RET: ['a'], HALT: [],
  NEWTABLE: ['a'], GET: ['a', 'b', 'c'], SET: ['a', 'b', 'c'], LEN: ['a', 'b'],
};

function rngFrom(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  return () => { s = (s ^ (s << 13)) >>> 0; s = (s ^ (s >>> 17)) >>> 0; s = (s ^ (s << 5)) >>> 0; return s; };
}

function makePerm(seed) {
  const rng = rngFrom(seed);
  const vals = Array.from({ length: 256 }, (_, i) => i);
  for (let i = vals.length - 1; i > 0; i--) { const j = rng() % (i + 1); [vals[i], vals[j]] = [vals[j], vals[i]]; }
  const enc = {};
  OPS.forEach((name, i) => { enc[name] = vals[i]; });
  return enc;
}

function makeKey(seed) {
  const rng = rngFrom(seed ^ 0xA5A5A5A5);
  return Array.from({ length: 16 }, () => rng() & 0xff);
}

function encodeProgram(program, consts, seed) {
  const perm = makePerm(seed), key = makeKey(seed);
  const bytes = [];
  program.forEach((ins, p) => {
    const fields = [perm[ins.op], ins.a ?? 0, ins.b ?? 0, ins.c ?? 0];
    fields.forEach((v, f) => {
      if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`field tidak valid di instruksi ${p}`);
      bytes.push((v + key[(p * 4 + f) % key.length]) % 256);
    });
  });
  return { bytes, key, perm, consts };
}

function luaString(obj) {
  const names = OPS.map((o) => `P_${o}`).join(',');
  const values = OPS.map((o) => obj.perm[o]).join(',');
  return `local ENC={${obj.bytes.join(',')}}
local KEY={${obj.key.join(',')}}
local CONST={${obj.consts.join(',')}}
local ${names}=${values}
local R={}
local STK={}
local pc=1
local function F(p,f)
  local g=(p-1)*4+f
  return (ENC[g+1]-KEY[g%#KEY+1])%256
end
while true do
  local op=F(pc,0)
  local a=F(pc,1)
  local b=F(pc,2)
  local c=F(pc,3)
  pc=pc+1
  if op==P_LOADK then R[a]=CONST[b+1]
  elseif op==P_MOVE then R[a]=R[b]
  elseif op==P_ADD then R[a]=R[b]+R[c]
  elseif op==P_SUB then R[a]=R[b]-R[c]
  elseif op==P_MUL then R[a]=R[b]*R[c]
  elseif op==P_LT then R[a]=(R[b]<R[c])
  elseif op==P_EQ then R[a]=(R[b]==R[c])
  elseif op==P_NOT then R[a]=(not R[b])
  elseif op==P_JMPF then if not R[a] then pc=b+1 end
  elseif op==P_JMP then pc=b+1
  elseif op==P_PRINT then print(R[a])
  elseif op==P_CALL then
    local start=CONST[b+1]
    local nargs=CONST[b+2]
    local NR={}
    for i=0,nargs-1 do NR[i]=R[c+i] end
    STK[#STK+1]={R=R,pc=pc,dest=a}
    R=NR
    pc=start+1
  elseif op==P_RET then
    local val=R[a]
    local fr=STK[#STK]
    STK[#STK]=nil
    R=fr.R
    pc=fr.pc
    R[fr.dest]=val
  elseif op==P_NEWTABLE then R[a]={}
  elseif op==P_GET then R[a]=R[b][R[c]]
  elseif op==P_SET then R[a][R[b]]=R[c]
  elseif op==P_LEN then R[a]=#R[b]
  elseif op==P_HALT then break
  else error("ALLZXRAA: opcode tidak valid",0) end
end
`;
}

// lifter linear: sapu seluruh bytecode, tidak berhenti di HALT
function disassemble(bytes, key, perm) {
  const inv = {};
  for (const name of OPS) inv[perm[name]] = name;
  const dec = (g) => (bytes[g] - key[g % key.length] + 256) % 256;
  const out = [];
  for (let p = 0; p * 4 < bytes.length; p++) {
    const f = [0, 1, 2, 3].map((k) => dec(p * 4 + k));
    const name = inv[f[0]];
    if (name === undefined) { out.push({ pc: p, op: null, raw: f[0] }); break; }
    const slot = { a: f[1], b: f[2], c: f[3] };
    const fields = Object.fromEntries(FIELDS[name].map((k) => [k, slot[k]]));
    out.push({ pc: p, op: name, args: FIELDS[name].map((k) => slot[k]), fields });
  }
  return out;
}

function listing(ins, consts) {
  return ins.map((i) => {
    if (i.op === null) return `${i.pc}: ??? (${i.raw})`;
    let text = i.args.length ? `${i.op} ${i.args.join(' ')}` : i.op;
    if (i.op === 'LOADK') text = `LOADK R${i.args[0]} K${i.args[1]}(${consts[i.args[1]]})`;
    if (i.op === 'CALL') text = `CALL R${i.args[0]} F@K${i.args[1]}(start=${consts[i.args[1]]},n=${consts[i.args[1] + 1]}) args=R${i.args[2]}..`;
    return `${i.pc}: ${text}`;
  }).join('\n');
}

module.exports = { FIELDS, OPS, makePerm, makeKey, encodeProgram, luaString, disassemble, listing };
