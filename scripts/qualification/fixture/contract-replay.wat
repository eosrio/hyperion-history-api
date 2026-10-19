;; Exact source of contractWasm in ../contract-fixture.ts.
;; No imports, table writes, notifications, authorization checks or action computation.
;; Transactions are nevertheless signed and executed by the owned Spring chain.
(module
  (memory (export "memory") 1)
  (func (export "apply") (param i64 i64 i64))
)
