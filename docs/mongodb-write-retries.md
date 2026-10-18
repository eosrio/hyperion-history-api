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
