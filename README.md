# ALLZXRAA COMMUNITY

## Lua legacy format

`/obfu-file` and `/obfu-link` keep producing the existing ALLZXRAA Lua wrapper
format. `/deobfu-file` accepts an uploaded wrapper and `/deobfu-link` accepts a
raw HTTP(S) link to one. Both deobfuscation commands decode the wrapper locally,
do not execute its Lua code, and include the ALLZXRAA banner at the beginning
of the output. Only the exact legacy wrapper format is supported.

The deobfuscation source limit follows `OBFU_MAX_BYTES` (default 25 MiB); the
encoded input is allowed additional room for the wrapper and its hex payload.

Run the unit tests with `npm test`.
