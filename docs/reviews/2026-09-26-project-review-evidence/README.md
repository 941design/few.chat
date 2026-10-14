**Archived evidence for the 2026-09-26 project review**

Implementation entry point: [handover and task ledger](../2026-09-26-project-review-handover.md).

These files were copied from the review's temporary output so a new context can inspect the evidence without `/tmp`. They describe commit `9eef568` and its then-current working tree, not future corrected behavior. Logs retain original paths, timestamps, terminal coloring, and test output. Source line numbers may drift.

| File | Purpose |
|---|---|
| [original-review.md](original-review.md) | Original ten findings and evidence limitations; source links made repository-relative |
| [unit.log](unit.log) | Baseline: 224 files passed, 4,405 tests passed, one skipped |
| [build.log](build.log) | Successful type checking/build/static export and bundle-size output |
| [regression-probes.test.ts.txt](regression-probes.test.ts.txt) | Six temporary diagnostic probes, archived as text so test discovery does not execute them |
| [probes.log](probes.log) | Final diagnostic run: six intended assertion failures; existing unit suite still passed |
| [e2e.log](e2e.log) | 70 browser passes and ambiguous-navigation-locator failure; aggregate stopped before relay tests |
| [relay-e2e.log](relay-e2e.log) | Separate relay run blocked by host port 3001 conflict before browser execution |

The probe file was originally temporarily placed at `app/tests/unit/review-probes.test.ts` and run through `make test-unit`. It has been removed from that location. Promote individual probes into suitable test modules with isolated setup/teardown; do not treat the archived convenience harness as production-ready tests. In particular, the NDK tests share module state and the diagnostic globals are not cleaned up when an assertion throws. All key material created explicitly by those probes is deterministic synthetic test data, not a user's identity.

Evidence strength matters: R04's probe validates signer replacement using synthetic signer objects; it does not establish a live NIP-46 session. R05 replaces deserialization but uses real handlers, ordinary synchronous EventEmitter behavior, and fake IndexedDB. R06–R08 exercise real persistence with fake IndexedDB. R09 constructs real NDK without connecting to a real relay. R01–R03 were traced in source rather than reproduced against live infrastructure.
