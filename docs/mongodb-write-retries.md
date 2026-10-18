# MongoDB write retries

MongoDB indexer batches remain unacknowledged until every required write succeeds.
On rejection, the worker logs the error and retries the same batch after one second.
The serial cargo task stays pending, so later batches on that worker cannot overtake
a partially applied batch. Other workers continue independently. A persistent write
error keeps that worker's batch pending; it is never counted as successfully indexed.

Writes within a collection preserve delivered order. Dynamic batches can write
independent collections concurrently, but wait for all collection writes to finish
before retrying. Retried writes use the existing upsert, delete, set, add-to-set and
pull operations; append-like permission links retain set semantics.

Successful batches acknowledge only their own delivery tags on the channel that
delivered them. If that channel is lost or replaced, its pending deliveries remain
recoverable through RabbitMQ redelivery. Old queued deliveries are discarded locally
and their tags are never acknowledged on a replacement channel. An acknowledgment
exception closes the originating channel so remaining deliveries can be redelivered.

This change does not add cross-worker state ordering, fork rollback, projection
transactions or channel-only reconnection. Existing channel recovery limitations
are tracked separately in [issue 187](https://github.com/eosrio/hyperion-history-api/issues/187).
The focused regressions inject database and AMQP boundary failures; they do not
replace qualification against live MongoDB and RabbitMQ services.

## Online state synchronization

State sync commands require a reachable controller that confirms every targeted
worker has cancelled delivery and drained both pending and running cargo work.
An empty pending queue is insufficient while a MongoDB batch is still retrying.
The controller waits up to eight seconds for all workers; the client also bounds
its request. Zero workers, failed IPC, worker exit, failed cancellation or timeout
abort synchronization. An unreachable controller is not treated as proof that
writing state is safe. Older controllers without the aggregate pause response
must be upgraded before using these sync commands.

Failed pauses clear controller timers and worker listeners, and late responses
cannot complete the failed request. They can leave some consumers paused, including
workers that finish draining after the deadline. Those workers are not automatically
resumed: check their status and resume or restart them manually before retrying.
When synchronization itself fails after a successful pause, the CLI attempts to
resume workers and propagates the failure. Detected resume request errors also
prevent a success result. Resume retains the existing first-response protocol:
completion does not confirm that every worker resumed. Check worker status after
synchronization; all-worker resume confirmation remains follow-up reliability work.
This pause barrier covers the selected workers; it does not coordinate worker
replacement or concurrent independent sync operations.
