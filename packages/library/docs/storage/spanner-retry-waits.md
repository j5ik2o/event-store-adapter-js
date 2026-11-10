# Spanner ABORTED retry waits

Manual read-write transactions retain the existing `transactionRetryLimit`. The initial attempt does not count toward that limit. Each retry opens a fresh transaction and repeats the head check with the same envelope and sequence number.

After rollback and transaction release, a retry waits for the first valid binary `google.rpc.RetryInfo` duration in the error metadata. Durations round upward to integer milliseconds, with a 1ms minimum. A valid duration above 60000ms stops with a storage error that retains the ABORTED cause. It never retries earlier by shortening that hint.

Missing or invalid metadata uses equal jitter. Retry caps are 50, 100, 200, 400, 800, then 1000ms. Each selected delay is an integer between half its cap and the cap, inclusive. Exhaustion returns the existing storage error before inspecting metadata or scheduling another wait.

A monotonic clock checks elapsed time after each timer wake. An early wake schedules the positive remainder. Timers retain their references and can keep the process alive while the operation is pending. Dropping the Promise or racing it against a timeout does not cancel retries. This adds no AbortSignal, total deadline, SDK runner, or transaction priority continuity.

Transaction acquisition failures, domain rejections, non-ABORTED failures, and failures after commit retain their existing error behavior. After-commit effects run once on success. The policy follows [common ADR 0009](https://github.com/j5ik2o/event-store-adapter/blob/ea561f8d2a1d008a9196e8b189268741fbc0c9ff/docs/adr/0009-bound-manual-spanner-aborted-retry-waits.md). Production contention benefits and real Spanner behavior have not been measured for this change.
