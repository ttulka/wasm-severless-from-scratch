;; answer.wat
(module
  (import "platform" "memory" (memory 1))
  (func (export "_start") 
        (result i32)
    i32.const 42 
    return))
