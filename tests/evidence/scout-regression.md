# Scout BLOCKED regression

The minimal F01/C11 test was run after the verified mechanical extraction and before the behavior correction. It failed semantically on `blocked scout diagnostic marker preserved`:

```text
✖ F01/C11 scout BLOCKED preserves diagnostic output (2.77425ms)
ℹ tests 1
ℹ suites 0
ℹ pass 0
ℹ fail 1
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 53.167584

✖ failing tests:

test at tests/workflow-scout-regression.test.mjs:5:1
✖ F01/C11 scout BLOCKED preserves diagnostic output (2.77425ms)
  AssertionError [ERR_ASSERTION]: blocked scout diagnostic marker preserved
      at TestContext.<anonymous> (file:///Users/ng/Documents/github/pi-manjerok/tests/workflow-scout-regression.test.mjs:9:10)
      at async Test.run (node:internal/test_runner/test:1069:7)
      at async startSubtestAfterBootstrap (node:internal/test_runner/harness:332:3) {
    generatedMessage: false,
    code: 'ERR_ASSERTION',
    actual: false,
    expected: true,
    operator: '=='
  }
```

The subsequent correction stores scout output before returning BLOCKED and gives the blocked transition a diagnostic fallback instead of `context gathered`.
