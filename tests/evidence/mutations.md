# M01 semantic mutation evidence

Baseline: all 8 test files pass before mutations on v24.1.0. Each mutation was applied in a separate temporary copy, imported, compiled as the real async workflow body, and executed by the named test. Copies were removed. Detection requires exit 1 and the expected ERR_ASSERTION; import, syntax, timer, and process errors are rejected.

Regenerate with `npm run test:mutations`.

## M01.1 worker budget >= becomes >

- Test: `B01 worker limit 1` in `tests/workflow-budgets.test.mjs`
- Violated expectation: First FAIL at worker limit 1 must launch senior, not another worker.
- Compiled: yes; detected: yes

```text
not ok 1 - B01 worker limit 1
  error: |-
    queued role order
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.2 remove mandatory senior review

- Test: `T07 explicit route` in `tests/workflow-transitions.test.mjs`
- Violated expectation: Successful senior verification must consume the queued reviewer before DONE.
- Compiled: yes; detected: yes

```text
not ok 1 - T07 explicit route and C07 evidence transfer
  error: |-
    unused queued response
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.3 FINDINGS goes straight to reviewer

- Test: `T12 explicit route` in `tests/workflow-transitions.test.mjs`
- Violated expectation: FINDINGS must launch the current implementer before any next review.
- Compiled: yes; detected: yes

```text
not ok 1 - T12 explicit route and C07 evidence transfer
  error: |-
    queued role order
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.4 reset verification counters on PASS

- Test: `B06 worker counter` in `tests/workflow-budgets.test.mjs`
- Violated expectation: Worker FAIL counter survives PASS and review; the second FAIL reaches its limit.
- Compiled: yes; detected: yes

```text
not ok 1 - B06 worker counter survives PASS and FINDINGS
  error: |-
    queued role order
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.5 reset shared review counter on escalation

- Test: `B08 reviewer budget` in `tests/workflow-budgets.test.mjs`
- Violated expectation: Second FINDINGS exhausts the shared limit even after changing implementer; no extra child may launch.
- Compiled: yes; detected: yes

```text
not ok 1 - B08 reviewer budget shared across escalation
  error: 'child-call bound exceeded'
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.6 malformed verifier verdict becomes success

- Test: `V04 missing verifier-worker` in `tests/workflow-verdicts.test.mjs`
- Violated expectation: Missing verifier verdict is BLOCKED, never DONE.
- Compiled: yes; detected: yes

```text
not ok 1 - V04 missing verifier-worker
  error: |-
    terminal status
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.7 remove fresh context

- Test: `C03 repeated` in `tests/workflow-contracts.test.mjs`
- Violated expectation: Every verifier and reviewer launch explicitly requests fresh context.
- Compiled: yes; detected: yes

```text
not ok 1 - C03 repeated verifier/reviewer calls use fresh context
  error: |-
    C03 fresh context
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.8 zero accumulated counters on BLOCKED

- Test: `F07 accumulated counters: F01` in `tests/workflow-failures.test.mjs`
- Violated expectation: BLOCKED preserves accumulated worker/senior/review counters 1/1/1.
- Compiled: yes; detected: yes

```text
not ok 1 - F07 accumulated counters: F01 explicit BLOCKED
  error: |-
    attempt counters
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.9 omit latest implementation from verifier packet

- Test: `T01 explicit route` in `tests/workflow-transitions.test.mjs`
- Violated expectation: Verifier receives the latest worker implementation output with its source.
- Compiled: yes; detected: yes

```text
not ok 1 - T01 explicit route and C07 evidence transfer
  error: 'verifier missing worker (attempt 1) evidence T01-worker'
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.10 omit latest PASS report from reviewer packet

- Test: `T02 explicit route` in `tests/workflow-transitions.test.mjs`
- Violated expectation: Reviewer receives the latest successful verifier report with its source.
- Compiled: yes; detected: yes

```text
not ok 1 - T02 explicit route and C07 evidence transfer
  error: 'reviewer missing verifier evidence T02-pass'
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.11 restore lost BLOCKED scout output

- Test: `F01/C11 scout` in `tests/workflow-scout-regression.test.mjs`
- Violated expectation: Blocked scout diagnostic output must remain in reason or evidence.
- Compiled: yes; detected: yes

```text
not ok 1 - F01/C11 scout BLOCKED preserves diagnostic output
  error: 'blocked scout diagnostic marker preserved'
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.12 omit worker explicit model

- Test: `C01/C02 worker nonempty` in `tests/workflow-contracts.test.mjs`
- Violated expectation: The configured worker model, including its thinking suffix, must be passed unchanged.
- Compiled: yes; detected: yes

```text
not ok 1 - C01/C02 worker nonempty model, other roles use distinct explicit models
  error: |-
    C01 exact model for worker
  code: 'ERR_ASSERTION'
# fail 1
```

## M01.13 omit verifier explicit model

- Test: `C01/C02 verifier nonempty` in `tests/workflow-contracts.test.mjs`
- Violated expectation: The configured verifier model, including its thinking suffix, must be passed unchanged.
- Compiled: yes; detected: yes

```text
not ok 1 - C01/C02 verifier nonempty model, other roles use distinct explicit models
  error: |-
    C01 exact model for verifier
  code: 'ERR_ASSERTION'
# fail 1
```
