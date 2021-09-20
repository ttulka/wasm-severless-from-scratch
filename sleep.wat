;; sleep.wat
(module
  (import "platform" "now" (func $now (result f64)))
  (func (export "_start")
        (local $target i64)
    i64.const 3000
    (i64.trunc_f64_s (call $now))
    i64.add
    local.set $target
    loop $loop
      (i64.trunc_f64_s (call $now))
      local.get $target
      i64.lt_s
    br_if $loop
    end))
