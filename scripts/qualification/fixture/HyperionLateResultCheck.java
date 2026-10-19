package org.elasticsearch.action.search;

import java.time.Instant;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

import org.apache.lucene.search.ScoreDoc;
import org.apache.lucene.search.TopDocs;
import org.apache.lucene.search.TotalHits;
import org.elasticsearch.Version;
import org.elasticsearch.common.breaker.CircuitBreaker;
import org.elasticsearch.common.breaker.NoopCircuitBreaker;
import org.elasticsearch.common.io.stream.StreamOutput;
import org.elasticsearch.common.lucene.search.TopDocsAndMaxScore;
import org.elasticsearch.common.util.BigArrays;
import org.elasticsearch.core.SimpleRefCounted;
import org.elasticsearch.index.shard.ShardId;
import org.elasticsearch.search.DocValueFormat;
import org.elasticsearch.search.SearchHits;
import org.elasticsearch.search.SearchPhaseResult;
import org.elasticsearch.search.SearchShardTarget;
import org.elasticsearch.search.aggregations.AggregationReduceContext;
import org.elasticsearch.search.aggregations.InternalAggregations;
import org.elasticsearch.search.aggregations.metrics.Sum;
import org.elasticsearch.search.aggregations.metrics.SumAggregationBuilder;
import org.elasticsearch.search.builder.SearchSourceBuilder;
import org.elasticsearch.search.internal.ShardSearchContextId;
import org.elasticsearch.search.query.QuerySearchResult;

/** Offline checks of the production classes in the exact server jar, not a REST integration test. */
public final class HyperionLateResultCheck {
    private static final int ROUNDS = 200;
    private static final int SHARDS = 8;
    private static int checks;

    private static void require(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        checks++;
    }

    private static final class OwnedResult extends SearchPhaseResult {
        private final SimpleRefCounted refs = new SimpleRefCounted();
        private Runnable onInc = () -> {};
        OwnedResult(int shard) { setShardIndex(shard); }
        @Override public void incRef() { onInc.run(); refs.incRef(); }
        @Override public boolean tryIncRef() { return refs.tryIncRef(); }
        @Override public boolean decRef() { return refs.decRef(); }
        @Override public boolean hasReferences() { return refs.hasReferences(); }
        @Override public void writeTo(StreamOutput output) { throw new UnsupportedOperationException("offline result"); }
    }

    private static final class AccountingBreaker extends NoopCircuitBreaker {
        private final AtomicLong bytes = new AtomicLong();
        private final AtomicLong peak = new AtomicLong();
        AccountingBreaker() { super(CircuitBreaker.REQUEST); }
        @Override public void addEstimateBytesAndMaybeBreak(long count, String label) { addWithoutBreaking(count); }
        @Override public void addWithoutBreaking(long count) {
            long now = bytes.addAndGet(count);
            if (now < 0 || now > 64L * 1024 * 1024) throw new AssertionError("invalid fixture breaker accounting: " + now);
            peak.accumulateAndGet(now, Math::max);
        }
        @Override public long getUsed() { return bytes.get(); }
    }

    private static SearchPhaseController controller() {
        return new SearchPhaseController((cancelled, aggregations) -> new AggregationReduceContext.Builder() {
            @Override public AggregationReduceContext forPartialReduction(Collection<SearchHits> hits) {
                return new AggregationReduceContext.ForPartial(BigArrays.NON_RECYCLING_INSTANCE, null,
                    cancelled, aggregations, ignored -> {}, hits);
            }
            @Override public AggregationReduceContext forFinalReduction(Collection<SearchHits> hits) {
                return new AggregationReduceContext.ForFinal(BigArrays.NON_RECYCLING_INSTANCE, null,
                    cancelled, aggregations, ignored -> {}, hits);
            }
        });
    }

    private static QueryPhaseResultConsumer consumer(int shards, AccountingBreaker breaker) {
        SearchRequest request = new SearchRequest("hyp-es955-internal");
        request.source(new SearchSourceBuilder().size(0).aggregation(new SumAggregationBuilder("sum").field("metric")));
        request.setBatchedReduceSize(shards);
        return new QueryPhaseResultConsumer(request,
            task -> { throw new AssertionError("this bounded case must not queue a partial merge"); },
            breaker, controller(), () -> false, SearchProgressListener.NOOP, shards,
            error -> { throw new AssertionError("unexpected partial merge failure", error); });
    }

    private static QuerySearchResult queryResult(int shard) {
        QuerySearchResult result = new QuerySearchResult(new ShardSearchContextId("", shard),
            new SearchShardTarget("fixture", new ShardId("hyp-es955-internal", "owned", shard), null), null);
        result.topDocs(new TopDocsAndMaxScore(new TopDocs(new TotalHits(0, TotalHits.Relation.EQUAL_TO),
            new ScoreDoc[0]), Float.NaN), new DocValueFormat[0]);
        result.aggregations(InternalAggregations.from(new Sum("sum", 1.0, DocValueFormat.RAW, Map.of())));
        result.setShardIndex(shard);
        return result;
    }

    private static void race(ExecutorService executor, List<Runnable> operations) throws Exception {
        CountDownLatch ready = new CountDownLatch(operations.size());
        CountDownLatch start = new CountDownLatch(1);
        List<Future<?>> futures = new ArrayList<>();
        for (Runnable operation : operations) {
            futures.add(executor.submit(() -> {
                ready.countDown();
                try {
                    if (!start.await(5, TimeUnit.SECONDS)) throw new AssertionError("start deadline exceeded");
                    operation.run();
                } catch (InterruptedException error) {
                    Thread.currentThread().interrupt();
                    throw new AssertionError("race interrupted", error);
                }
            }));
        }
        if (!ready.await(5, TimeUnit.SECONDS)) throw new AssertionError("ready deadline exceeded");
        start.countDown();
        for (Future<?> future : futures) future.get(5, TimeUnit.SECONDS);
    }

    private static void arrays(ExecutorService executor) throws Exception {
        OwnedResult early = new OwnedResult(0);
        ArraySearchPhaseResults<OwnedResult> collected = new ArraySearchPhaseResults<>(1);
        AtomicInteger callbacks = new AtomicInteger();
        collected.consumeResult(early, callbacks::incrementAndGet);
        require(early.refs.refCount() == 2, "collection must retain a live result");
        early.decRef();
        collected.close();
        collected.close();
        require(!early.hasReferences(), "close must release the stored result exactly once");
        require(callbacks.get() == 1, "early continuation count");

        ArraySearchPhaseResults<OwnedResult> closed = new ArraySearchPhaseResults<>(1);
        closed.close();
        OwnedResult late = new OwnedResult(0);
        callbacks.set(0);
        closed.consumeResult(late, callbacks::incrementAndGet);
        require(!closed.hasResult(0), "closed collection must not store a late result");
        require(late.refs.refCount() == 1, "late arrival must not acquire a new reference");
        require(callbacks.get() == 1, "late continuation must still run");
        late.decRef();
        require(!late.hasReferences(), "late caller reference must be last");

        ArraySearchPhaseResults<OwnedResult> fromContinuation = new ArraySearchPhaseResults<>(1);
        OwnedResult continuation = new OwnedResult(0);
        fromContinuation.consumeResult(continuation, fromContinuation::close);
        continuation.decRef();
        require(!continuation.hasReferences(), "continuation close must release its stored result");

        ArraySearchPhaseResults<OwnedResult> gap = new ArraySearchPhaseResults<>(1);
        OwnedResult inGap = new OwnedResult(0);
        inGap.onInc = gap::close;
        gap.consumeResult(inGap, () -> {});
        inGap.decRef();
        require(!inGap.hasReferences(), "close between storage and incRef must release the result");

        for (int round = 0; round < ROUNDS; round++) {
            ArraySearchPhaseResults<OwnedResult> results = new ArraySearchPhaseResults<>(SHARDS);
            List<OwnedResult> values = new ArrayList<>();
            List<Runnable> operations = new ArrayList<>();
            AtomicInteger completed = new AtomicInteger();
            for (int shard = 0; shard < SHARDS; shard++) {
                OwnedResult value = new OwnedResult(shard);
                values.add(value);
                operations.add(() -> results.consumeResult(value, completed::incrementAndGet));
            }
            operations.add(results::close);
            race(executor, operations);
            results.close();
            require(completed.get() == SHARDS, "every concurrent array continuation must run");
            for (OwnedResult value : values) {
                value.decRef();
                require(!value.hasReferences(), "concurrent array close leaked a reference");
            }
        }
    }

    private static long queryConsumers(ExecutorService executor) throws Exception {
        AccountingBreaker breaker = new AccountingBreaker();
        QueryPhaseResultConsumer closed = consumer(2, breaker);
        QuerySearchResult early = queryResult(0);
        closed.consumeResult(early, () -> {});
        early.decRef();
        require(breaker.getUsed() > 0, "early aggregation must charge the supplied breaker");
        closed.close();
        require(breaker.getUsed() == 0, "close must return aggregation accounting to zero");
        require(!early.hasReferences(), "close must release early query result");
        QuerySearchResult late = queryResult(1);
        AtomicInteger callbacks = new AtomicInteger();
        closed.consumeResult(late, callbacks::incrementAndGet);
        require(callbacks.get() == 1, "closed query consumer must run late continuation");
        require(breaker.getUsed() == 0, "late aggregation must not create a lasting breaker charge");
        require(late.aggregations() == null, "late aggregation storage must be released");
        late.decRef();
        require(!late.hasReferences(), "late query caller reference must be last");
        closed.close();

        AccountingBreaker failedBreaker = new AccountingBreaker();
        QueryPhaseResultConsumer failed = consumer(2, failedBreaker);
        QuerySearchResult failedEarly = queryResult(0);
        failed.consumeResult(failedEarly, () -> {});
        failedEarly.decRef();
        require(failedBreaker.getUsed() > 0, "failed phase must first hold a measured aggregation charge");
        RuntimeException injected = new RuntimeException("offline phase failure");
        failed.setFailure(injected);
        failed.close();
        require(failedBreaker.getUsed() == 0, "closing a failed consumer must release its earlier breaker charge");
        require(!failedEarly.hasReferences(), "closing a failed consumer must release its earlier result");
        QuerySearchResult afterFailure = queryResult(1);
        callbacks.set(0);
        failed.consumeResult(afterFailure, callbacks::incrementAndGet);
        require(failed.getFailure() == injected, "production consumer must retain the supplied failure");
        require(callbacks.get() == 1, "failed query consumer must run late continuation");
        require(afterFailure.aggregations() == null, "failed consumer must discard late aggregations");
        afterFailure.decRef();
        failed.close();
        require(!afterFailure.hasReferences(), "failed consumer must not retain late result");
        require(failedBreaker.getUsed() == 0, "failed consumer must have no outstanding breaker charge");

        for (int round = 0; round < ROUNDS; round++) {
            AccountingBreaker accounting = new AccountingBreaker();
            QueryPhaseResultConsumer results = consumer(SHARDS, accounting);
            List<QuerySearchResult> values = new ArrayList<>();
            List<Runnable> operations = new ArrayList<>();
            AtomicInteger completed = new AtomicInteger();
            for (int shard = 0; shard < SHARDS; shard++) {
                QuerySearchResult value = queryResult(shard);
                values.add(value);
                operations.add(() -> results.consumeResult(value, completed::incrementAndGet));
            }
            operations.add(results::close);
            race(executor, operations);
            results.close();
            require(accounting.getUsed() == 0, "concurrent close left aggregation accounting charged");
            require(completed.get() == SHARDS, "every concurrent query continuation must run");
            for (QuerySearchResult value : values) {
                require(value.aggregations() == null, "concurrent close retained aggregation storage");
                value.decRef();
                require(!value.hasReferences(), "concurrent query close leaked a reference");
            }
        }
        return breaker.peak.get();
    }

    public static void main(String[] args) throws Exception {
        require(args.length == 0, "this check accepts no external targets");
        require("9.5.5".equals(Version.CURRENT.toString()), "exact server version required");
        require(Runtime.version().feature() == 27, "exact bundled Java major required");
        require(ArraySearchPhaseResults.class.desiredAssertionStatus(), "run with -ea");
        String productionJar = ArraySearchPhaseResults.class.getProtectionDomain().getCodeSource().getLocation().toString();
        require(productionJar.endsWith("/elasticsearch-9.5.5.jar"), "must execute the production jar classes");
        ExecutorService executor = Executors.newFixedThreadPool(SHARDS + 1);
        long peak;
        try { arrays(executor); peak = queryConsumers(executor); }
        finally {
            executor.shutdownNow();
            if (!executor.awaitTermination(5, TimeUnit.SECONDS)) throw new AssertionError("worker shutdown exceeded deadline");
        }
        System.out.println("{\"schema_version\":1,\"scope\":\"offline-production-class-check\",\"status\":\"passed\","
            + "\"server_version\":\"9.5.5\",\"java_major\":27,\"assertions_enabled\":true,"
            + "\"array_race_rounds\":" + ROUNDS + ",\"query_consumer_race_rounds\":" + ROUNDS
            + ",\"shards_per_round\":" + SHARDS + ",\"checks\":" + checks + ",\"early_breaker_peak_bytes\":" + peak
            + ",\"final_breaker_bytes\":0,\"production_jar\":\"" + productionJar + "\",\"completed_at\":\"" + Instant.now() + "\"}");
    }
}
