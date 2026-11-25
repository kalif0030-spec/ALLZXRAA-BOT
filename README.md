# ALLZXRAA COMMUNITY

## Lua obfuscation formats

`/obfu-file` and `/obfu-link` offer four modes:

- `ALLZXRAA lama` (default when no mode is selected) keeps the existing wrapper
  format byte-for-byte compatible.
- `LuaRaph-style` emits an ALLZXRAA-branded string-table wrapper. It is an
  internal style profile, not a claim of compatibility with an external LuaRaph
  implementation.
- `VM wrapper` emits a small bytecode-style decoder wrapper. It restores the
  Lua source and passes it to Lua's `loadstring`/`load`; it does not compile Lua
  statements into virtual-machine instructions.
- `Kombinasi` nests the LuaRaph-style, VM, and legacy wrappers.

The mode is an optional slash-command choice on both obfuscate commands. Leaving
it unset preserves the old ALLZXRAA output. `/deobfu-file` accepts an uploaded
output and `/deobfu-link` accepts a raw HTTP(S) link. Both decode the built-in
formats locally without executing their Lua payload, recursively unwrap the
combined format, and include the ALLZXRAA banner at the beginning of the
deobfuscated source.

The deobfuscation source limit follows `OBFU_MAX_BYTES` (default 25 MiB); the
encoded input and generated wrapper are allowed additional room for their
encoded payloads. The deobfuscator only accepts the exact built-in wrapper
formats.

Run the unit tests with `npm test`.
