-- Harness sandbox untuk deobfuscate dinamis.
-- Dijalankan di state fengari (Lua 5.3) yang cuma punya base, string, table, math, utf8,
-- coroutine, dan debug. Script target jalan di tabel ENV terpisah, jadi _G asli tidak
-- kelihatan olehnya. Input dari JS: __SRC (string), __LIMITS (tabel), __emit_layer(n, src),
-- __emit_log(line).
-- Semantik Lua 5.3, BUKAN Lua 5.1/Luau: tostring(1.0) = "1.0", ada subtipe integer, dll.

local emit_layer, emit_log = __emit_layer, __emit_log
local SRC, LIMITS = __SRC, __LIMITS
__emit_layer, __emit_log, __SRC, __LIMITS = nil, nil, nil, nil

local G = _G
local rawload, rawpcall, rawxpcall, rawerror = load, pcall, xpcall, error
local rawtostring, rawtype, rawtonumber = tostring, type, tonumber
local rawget, rawset, rawequal = rawget, rawset, rawequal
local setmt, getmt, select, next, pairs, ipairs = setmetatable, getmetatable, select, next, pairs, ipairs
local sformat, ssub, srep, sbyte, sgsub, sfind = string.format, string.sub, string.rep, string.byte, string.gsub, string.find
local tconcat, tunpack = table.concat, table.unpack
local mtype = math.type
local dgetupvalue, dsetupvalue = debug.getupvalue, debug.setupvalue

local MAX_LOG, MAX_LAYERS = LIMITS.maxLogLines, LIMITS.maxLayers
local MAX_WAIT, MAX_STR = LIMITS.maxWaitCalls, LIMITS.maxStringBytes

-- ============ log ============
local logCount = 0
local function log(kind, text)
  if logCount >= MAX_LOG then return end
  logCount = logCount + 1
  if #text > 400 then text = ssub(text, 1, 400) .. "..." end
  emit_log("[" .. kind .. "] " .. text)
  if logCount == MAX_LOG then emit_log("[log] batas baris log tercapai, sisanya dibuang") end
end

-- ============ format nilai untuk log ============
local names = {}    -- proxy -> nama
local parents = {}  -- proxy -> proxy induk (untuk mengenali pemanggilan gaya metode)
local children = {} -- proxy -> { kunci -> proxy anak }

local function fmtstr(s)
  if #s > 300 then s = ssub(s, 1, 300) .. "..." end
  local pattern = utf8.len(s) and '[%c"\\]' or '[^\32-\126]'
  local escaped = sgsub(s, pattern, function(c) return sformat("\\%d", sbyte(c)) end)
  return '"' .. escaped .. '"'
end

local function fmtval(v, depth)
  local t = rawtype(v)
  if t == "string" then return fmtstr(v) end
  if t == "number" or t == "boolean" or t == "nil" then return rawtostring(v) end
  if t == "table" then
    local nm = names[v]
    if nm then return nm end
    if (depth or 0) >= 1 then return "{...}" end
    local parts, count = {}, 0
    local k, val = next(v)
    while k ~= nil do
      count = count + 1
      if count > 8 then parts[#parts + 1] = "..."; break end
      if mtype(k) == "integer" and k == count then
        parts[#parts + 1] = fmtval(val, 1)
      else
        local ks
        if rawtype(k) == "string" and sfind(k, "^[%a_][%w_]*$") then ks = k else ks = "[" .. fmtval(k, 1) .. "]" end
        parts[#parts + 1] = ks .. "=" .. fmtval(val, 1)
      end
      k, val = next(v, k)
    end
    return "{" .. tconcat(parts, ", ") .. "}"
  end
  return "<" .. t .. ">"
end

local function fmtargs(...)
  local n = select("#", ...)
  local out = {}
  for i = 1, n do
    if i > 8 then out[#out + 1] = "..."; break end
    out[#out + 1] = fmtval((select(i, ...)), 0)
  end
  return tconcat(out, ", ")
end

local function tostr(x)
  local nm = names[x]
  if nm then return nm end
  if rawtype(x) == "string" then return x end
  local ok, r = rawpcall(rawtostring, x)
  if ok and rawtype(r) == "string" then return r end
  return "<" .. rawtype(x) .. ">"
end

local function keystr(k)
  if rawtype(k) == "string" and sfind(k, "^[%a_][%w_]*$") then return "." .. k end
  return "[" .. fmtval(k, 1) .. "]"
end

-- ============ proxy pencatat ============
local proxy_mt
local function newproxy_(name, parent)
  if #name > 200 then name = ssub(name, 1, 200) .. "..." end
  local p = setmt({}, proxy_mt)
  names[p] = name
  if parent ~= nil then parents[p] = parent end
  return p
end

proxy_mt = {
  __metatable = "locked",
  __index = function(self, k)
    local c = children[self]
    if not c then c = {}; children[self] = c end
    if k ~= k then k = "nan" end
    local child = c[k]
    if child == nil then
      child = newproxy_(names[self] .. keystr(k), self)
      c[k] = child
      log("get", names[child])
    end
    return child
  end,
  __newindex = function(self, k, v)
    log("set", names[self] .. keystr(k) .. " = " .. fmtval(v, 0))
  end,
  __call = function(self, ...)
    local n = select("#", ...)
    local par = parents[self]
    local callname
    if par ~= nil and n >= 1 and rawequal((...), par) then
      local pname = names[par]
      local mname = ssub(names[self], #pname + 1)
      local label
      if ssub(mname, 1, 1) == "." then label = pname .. ":" .. ssub(mname, 2) else label = pname .. mname end
      callname = label .. "(" .. fmtargs(select(2, ...)) .. ")"
    else
      callname = names[self] .. "(" .. fmtargs(...) .. ")"
    end
    log("call", callname)
    return newproxy_(callname, nil)
  end,
  __concat = function(a, b) return newproxy_("(" .. tostr(a) .. " .. " .. tostr(b) .. ")") end,
  __unm = function(a) return newproxy_("(-" .. tostr(a) .. ")") end,
  __len = function() return 0 end,
  __lt = function() return false end,
  __le = function() return false end,
  __tostring = function(self) return names[self] end,
  __pairs = function(self) return function() return nil end, self, nil end,
}
for op, sym in pairs({ __add = "+", __sub = "-", __mul = "*", __div = "/", __mod = "%", __pow = "^", __idiv = "//" }) do
  proxy_mt[op] = function(a, b) return newproxy_("(" .. tostr(a) .. " " .. sym .. " " .. tostr(b) .. ")") end
end

-- ============ lingkungan target ============
local ENV = {}
setmt(ENV, {
  __metatable = "locked",
  __index = function(t, k)
    if rawtype(k) ~= "string" then return nil end
    local p = newproxy_(k, nil)
    rawset(t, k, p)
    log("global", k)
    return p
  end,
})
local function put(k, v) rawset(ENV, k, v) end

for _, k in ipairs({ "assert", "error", "getmetatable", "next", "pcall", "rawequal", "rawget", "rawlen",
                     "rawset", "select", "setmetatable", "tonumber", "tostring", "type", "xpcall" }) do
  put(k, G[k])
end
put("_G", ENV)
put("_VERSION", "Lua 5.1")
put("unpack", tunpack)
put("typeof", function(v) if names[v] then return "Instance" end return rawtype(v) end)
put("collectgarbage", function() return 0 end)
put("newproxy", function(addmeta) local t = {}; if addmeta then setmt(t, {}) end; return t end)
put("pairs", pairs)
-- ipairs asli di Lua 5.3 menghormati __index, jadi proxy akan membuatnya berputar selamanya.
put("ipairs", function(t)
  if names[t] then return function() return nil end, t, 0 end
  return ipairs(t)
end)

-- string / table / math: tabel aslinya dipakai bersama supaya pemanggilan gaya ("x"):metode tetap jalan.
string.rep = function(s, n, sep)
  local unit = #rawtostring(s) + (sep and #rawtostring(sep) or 0)
  if rawtype(n) == "number" and n > 0 and unit * n > MAX_STR then
    rawerror("sandbox: string.rep melebihi batas ukuran", 2)
  end
  return srep(s, n, sep)
end
table.getn = function(t) return #t end
table.find = function(t, v, init)
  for i = init or 1, #t do if t[i] == v then return i end end
  return nil
end
table.clear = function(t) for k in pairs(t) do t[k] = nil end end
table.create = function(n, v)
  if n > 1000000 then rawerror("sandbox: table.create terlalu besar", 2) end
  local t = {}
  if v ~= nil then for i = 1, n do t[i] = v end end
  return t
end
table.clone = function(t)
  local c = {}
  for k, v in pairs(t) do c[k] = v end
  local mt = getmt(t)
  if rawtype(mt) == "table" then setmt(c, mt) end
  return c
end
table.freeze = function(t) return t end
table.isfrozen = function() return false end
math.pow = function(a, b) return a ^ b end
math.atan2 = function(y, x) return math.atan(y, x) end
math.log10 = function(x) return math.log(x, 10) end
math.clamp = function(x, lo, hi) if x < lo then return lo elseif x > hi then return hi end return x end
math.sign = function(x) if x > 0 then return 1 elseif x < 0 then return -1 end return 0 end
put("string", string); put("table", table); put("math", math)
put("utf8", utf8); put("coroutine", coroutine)

-- bit32 (Lua 5.1/Luau) dibangun dari operator bitwise Lua 5.3.
local function u32(x) return math.floor(x % 4294967296) end
local bit32 = {}
function bit32.band(...)
  local r = 0xFFFFFFFF
  for i = 1, select("#", ...) do r = r & u32((select(i, ...))) end
  return r
end
function bit32.bor(...)
  local r = 0
  for i = 1, select("#", ...) do r = r | u32((select(i, ...))) end
  return r
end
function bit32.bxor(...)
  local r = 0
  for i = 1, select("#", ...) do r = r ~ u32((select(i, ...))) end
  return r
end
function bit32.bnot(x) return (~u32(x)) & 0xFFFFFFFF end
function bit32.btest(...) return bit32.band(...) ~= 0 end
function bit32.lshift(x, n)
  n = math.floor(n)
  if n < 0 then return bit32.rshift(x, -n) end
  if n >= 32 then return 0 end
  return (u32(x) << n) & 0xFFFFFFFF
end
function bit32.rshift(x, n)
  n = math.floor(n)
  if n < 0 then return bit32.lshift(x, -n) end
  if n >= 32 then return 0 end
  return u32(x) >> n
end
function bit32.arshift(x, n)
  x = u32(x); n = math.floor(n)
  if n < 0 then return bit32.lshift(x, -n) end
  if n >= 32 then return (x & 0x80000000) ~= 0 and 0xFFFFFFFF or 0 end
  local r = x >> n
  if (x & 0x80000000) ~= 0 then r = r | ((0xFFFFFFFF << (32 - n)) & 0xFFFFFFFF) end
  return r
end
function bit32.lrotate(x, n)
  n = math.floor(n) % 32; x = u32(x)
  return ((x << n) | (x >> (32 - n))) & 0xFFFFFFFF
end
function bit32.rrotate(x, n) return bit32.lrotate(x, -math.floor(n)) end
function bit32.extract(n, field, width)
  width = width or 1
  return (u32(n) >> field) & ((1 << width) - 1)
end
function bit32.replace(n, v, field, width)
  width = width or 1
  local mask = ((1 << width) - 1) << field
  return (u32(n) & ~mask & 0xFFFFFFFF) | ((u32(v) << field) & mask)
end
put("bit32", bit32); put("bit", bit32)

-- waktu deterministik, tapi selalu maju supaya loop "tunggu waktu" tidak macet.
local clock = 0
put("os", {
  time = function() clock = clock + 1; return 1700000000 + clock end,
  clock = function() clock = clock + 0.001; return clock end,
  date = function() return "2023-11-14 00:00:00" end,
  getenv = function() return nil end,
  difftime = function(a, b) return (a or 0) - (b or 0) end,
})
put("tick", function() clock = clock + 0.001; return 1700000000 + clock end)
put("time", function() clock = clock + 0.001; return clock end)
put("elapsedTime", function() clock = clock + 0.001; return clock end)

put("debug", {
  traceback = function(m) return rawtype(m) == "string" and m or "" end,
  getinfo = function() return { short_src = "sandbox", source = "=sandbox", currentline = 0, what = "Lua", name = "?", nups = 0 } end,
  sethook = function() end, gethook = function() return nil end,
  getlocal = function() return nil end, getupvalue = function() return nil end,
  getmetatable = getmt, setmetatable = setmt, getregistry = function() return {} end,
})

-- print / warn / require
local function printer(kind)
  return function(...)
    local parts = {}
    for i = 1, select("#", ...) do parts[#parts + 1] = tostr((select(i, ...))) end
    log(kind, tconcat(parts, "\t"))
  end
end
put("print", printer("print")); put("warn", printer("warn"))
put("require", function(x)
  local label = "require(" .. fmtval(x, 0) .. ")"
  log("call", label)
  return newproxy_(label, nil)
end)

-- wait / spawn: spawn menjalankan fungsinya langsung; wait dibatasi supaya loop tak berujung berhenti.
local waitCalls = 0
local function wait_()
  waitCalls = waitCalls + 1
  if waitCalls > MAX_WAIT then rawerror("sandbox: batas pemanggilan wait tercapai (loop tak berujung?)", 0) end
  return 0.03, 0.03
end
local function spawn_(f, ...)
  if rawtype(f) == "function" then
    local ok, err = rawpcall(f, ...)
    if not ok then log("error", "dalam spawn: " .. tostr(err)) end
  end
  return newproxy_("thread", nil)
end
put("wait", wait_); put("spawn", spawn_)
put("delay", function(_, f, ...) return spawn_(f, ...) end)
put("task", { wait = wait_, spawn = spawn_, defer = spawn_, cancel = function() end,
              delay = function(_, f, ...) return spawn_(f, ...) end })

-- fungsi khas executor yang perlu perilaku nyata; sisanya otomatis jadi proxy pencatat.
put("getgenv", function() return ENV end)
put("getrenv", function() return ENV end)
put("getsenv", function() return ENV end)
put("getfenv", function() return ENV end)
put("setfenv", function(f, env)
  if rawtype(f) == "function" and rawtype(env) == "table" and dgetupvalue(f, 1) == "_ENV" then
    dsetupvalue(f, 1, env)
  end
  return f
end)
put("identifyexecutor", function() return "Sandbox", "1.0" end)
put("checkcaller", function() return true end)
put("newcclosure", function(f) return f end)
put("clonefunction", function(f) return f end)
put("islclosure", function() return true end)

-- ============ penangkap loadstring / load ============
local layerCount = 0
local function capture(src, chunkname)
  layerCount = layerCount + 1
  if layerCount > MAX_LAYERS then
    if layerCount == MAX_LAYERS + 1 then
      log("load", "batas layer tersimpan tercapai (" .. MAX_LAYERS .. "), layer berikutnya tetap dijalankan tapi tidak disimpan")
    end
    return layerCount
  end
  local nm = rawtype(chunkname) == "string" and (" nama=" .. fmtval(chunkname, 0)) or ""
  log("load", "layer " .. layerCount .. " (" .. #src .. " byte)" .. nm)
  emit_layer(layerCount, src)
  return layerCount
end

local function load_(chunk, chunkname, mode, env)
  local src = chunk
  if rawtype(chunk) == "function" then
    local parts, total = {}, 0
    for _ = 1, 100000 do
      local piece = chunk()
      if piece == nil or piece == "" then break end
      if rawtype(piece) ~= "string" then return nil, "reader function must return a string" end
      total = total + #piece
      if total > MAX_STR then return nil, "chunk terlalu besar" end
      parts[#parts + 1] = piece
    end
    src = tconcat(parts)
  end
  if names[src] then
    log("load", "argumen berupa proxy " .. names[src] .. " (isi tidak tersedia di sandbox)")
    return function() return newproxy_("loaded:" .. names[src], nil) end
  end
  if rawtype(src) ~= "string" then return nil, "bad argument #1 to 'load' (string expected)" end
  local n = capture(src, chunkname)
  local f, err = rawload(src, rawtype(chunkname) == "string" and chunkname or "=(load)", "t", env or ENV)
  if not f then
    log("load", "layer " .. n .. " tidak bisa dikompilasi oleh Lua 5.3: " .. tostr(err))
    return nil, err
  end
  return f
end
put("loadstring", load_); put("load", load_)

-- ============ jalankan target ============
local mainFn, cerr = rawload(SRC, "=target", "t", ENV)
if not mainFn then
  log("error", "script target tidak bisa dikompilasi oleh Lua 5.3 (sintaks Luau atau 5.1-only?): " .. tostr(cerr))
  return
end
local ok, err = rawxpcall(mainFn, function(e) return tostr(e) end)
if not ok then log("error", err) end
log("done", "selesai; layer tertangkap: " .. layerCount)
