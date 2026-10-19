package io.eosrio.qualification;

import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.function.Predicate;
import java.util.function.Supplier;
import java.util.concurrent.locks.LockSupport;
import java.util.concurrent.atomic.AtomicBoolean;

import org.apache.lucene.search.IndexSearcher;
import org.apache.lucene.search.MatchAllDocsQuery;
import org.apache.lucene.search.Query;
import org.apache.lucene.search.QueryVisitor;
import org.elasticsearch.TransportVersion;
import org.elasticsearch.client.internal.node.NodeClient;
import org.elasticsearch.cluster.node.DiscoveryNodes;
import org.elasticsearch.common.io.stream.StreamInput;
import org.elasticsearch.common.io.stream.StreamOutput;
import org.elasticsearch.common.settings.Settings;
import org.elasticsearch.features.NodeFeature;
import org.elasticsearch.index.query.AbstractQueryBuilder;
import org.elasticsearch.index.query.SearchExecutionContext;
import org.elasticsearch.plugins.ActionPlugin;
import org.elasticsearch.plugins.Plugin;
import org.elasticsearch.plugins.ScriptPlugin;
import org.elasticsearch.plugins.SearchPlugin;
import org.elasticsearch.rest.BaseRestHandler;
import org.elasticsearch.rest.RestHandler;
import org.elasticsearch.rest.RestRequest;
import org.elasticsearch.rest.RestResponse;
import org.elasticsearch.rest.RestStatus;
import org.elasticsearch.script.FilterScript;
import org.elasticsearch.script.ScriptContext;
import org.elasticsearch.script.ScriptEngine;
import org.elasticsearch.search.internal.ContextIndexSearcher;
import org.elasticsearch.search.internal.MaxClauseCountQueryVisitor;
import org.elasticsearch.tasks.TaskCancelledException;
import org.elasticsearch.xcontent.XContentBuilder;
import org.elasticsearch.xcontent.XContentParser;

/** Fault injection for a disposable 9.5.5 fixture. Never install on an operator cluster. */
public final class HyperionQualifierPlugin extends Plugin implements ScriptPlugin, ActionPlugin, SearchPlugin {
    private static final int MAX_KEYS = 64;
    private static final int MAX_EVENTS = 256;
    private static final Map<String, ProbeState> STATES = new LinkedHashMap<>();
    private static String key(Object value) {
        if (!(value instanceof String text) || !text.matches("hyp-es955-[a-z0-9][a-z0-9-]{0,69}")) {
            throw new IllegalArgumentException("key must match hyp-es955-[a-z0-9][a-z0-9-]{0,69}");
        }
        return text;
    }

    private static synchronized ProbeState state(String key) {
        ProbeState result = STATES.get(key);
        if (result == null) {
            if (STATES.size() >= MAX_KEYS) {
                throw new IllegalStateException("qualification key limit reached; reset completed keys");
            }
            result = new ProbeState(key);
            STATES.put(key, result);
        }
        return result;
    }

    private static synchronized Map<String, Object> snapshot(String key, boolean reset) {
        if (key != null) {
            ProbeState value = STATES.get(key);
            if (value == null) return new ProbeState(key).snapshot();
            synchronized (value) {
                Map<String, Object> result = value.snapshot();
                if (reset) {
                    if (value.active != 0) throw new IllegalStateException("cannot reset active qualification work");
                    STATES.remove(key);
                }
                return result;
            }
        }
        List<Map<String, Object>> probes = new ArrayList<>();
        for (ProbeState value : STATES.values()) probes.add(value.snapshot());
        return Map.of("fixture_only", true, "max_keys", MAX_KEYS, "max_events_per_key", MAX_EVENTS, "probes", probes);
    }

    private static final class ProbeState {
        private final String key;
        private final ArrayDeque<Map<String, Object>> events = new ArrayDeque<>();
        private long sequence;
        private int active;
        private long entered, completed, taskCancelled, queryTimedOut, failed, dropped;
        private long slowEntered, slowCompleted, slowTaskCancelled, slowQueryTimedOut, slowFailed, delayStarted, delayFinished;
        private int activeSlow, delayActive;

        ProbeState(String key) { this.key = key; }

        synchronized void event(String event, String role, String mode, long started, String exception) {
            switch (event) {
                case "entered" -> { entered++; active++; }
                case "completed" -> { completed++; active--; }
                case "task_cancelled" -> { taskCancelled++; active--; }
                case "query_timed_out" -> { queryTimedOut++; active--; }
                case "failed" -> { failed++; active--; }
                default -> throw new IllegalArgumentException("unknown event");
            }
            if ("slow".equals(role)) {
                switch (event) {
                    case "entered" -> { slowEntered++; activeSlow++; }
                    case "completed" -> { slowCompleted++; activeSlow--; }
                    case "task_cancelled" -> { slowTaskCancelled++; activeSlow--; }
                    case "query_timed_out" -> { slowQueryTimedOut++; activeSlow--; }
                    case "failed" -> { slowFailed++; activeSlow--; }
                    default -> { }
                }
            }
            if (events.size() == MAX_EVENTS) { events.removeFirst(); dropped++; }
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("sequence", ++sequence);
            item.put("event", event);
            item.put("role", role);
            item.put("mode", mode);
            item.put("wall_ms", System.currentTimeMillis());
            item.put("elapsed_ms", (System.nanoTime() - started) / 1_000_000.0);
            if (exception != null) item.put("exception", exception);
            events.addLast(item);
        }

        synchronized Map<String, Object> snapshot() {
            Map<String, Object> result = new LinkedHashMap<>();
            result.put("key", key);
            result.put("active", active);
            result.put("entered", entered);
            result.put("completed", completed);
            result.put("task_cancelled", taskCancelled);
            result.put("query_timed_out", queryTimedOut);
            result.put("failed", failed);
            result.put("active_slow", activeSlow);
            result.put("slow_entered", slowEntered);
            result.put("slow_completed", slowCompleted);
            result.put("slow_task_cancelled", slowTaskCancelled);
            result.put("slow_query_timed_out", slowQueryTimedOut);
            result.put("slow_failed", slowFailed);
            result.put("delay_active", delayActive);
            result.put("delay_started", delayStarted);
            result.put("delay_finished", delayFinished);
            result.put("dropped_events", dropped);
            result.put("events", new ArrayList<>(events));
            return result;
        }

        synchronized void beginDelay() { delayStarted++; delayActive++; }
        synchronized void endDelay() { delayFinished++; delayActive--; }
    }

    @Override
    public ScriptEngine getScriptEngine(Settings settings, Collection<ScriptContext<?>> contexts) {
        return new ScriptEngine() {
            @Override public String getType() { return "hyperion_qualifier"; }
            @Override public Set<ScriptContext<?>> getSupportedContexts() { return Set.of(FilterScript.CONTEXT); }
            @Override
            public <T> T compile(String name, String source, ScriptContext<T> context, Map<String, String> options) {
                if (!"gate".equals(source) || context != FilterScript.CONTEXT) {
                    throw new IllegalArgumentException("only gate in the filter context is supported");
                }
                FilterScript.Factory factory = (params, lookup) -> {
                    String probeKey = key(params.get("key"));
                    String mode = String.valueOf(params.get("mode"));
                    if (!Set.of("timeout", "fail", "cancel", "mixed", "late").contains(mode)) {
                        throw new IllegalArgumentException("unsupported qualification mode");
                    }
                    Object delayValue = params.get("delay_ms");
                    if (!(delayValue instanceof Number number) || number.doubleValue() != number.longValue()
                        || number.longValue() < 1 || number.longValue() > 2000) {
                        throw new IllegalArgumentException("delay_ms must be an integer from 1 through 2000");
                    }
                    long delayNanos = number.longValue() * 1_000_000L;
                    ProbeState probe = state(probeKey);
                    // One bounded delay per shard/leaf factory, not one delay per matched document.
                    AtomicBoolean delayed = new AtomicBoolean();
                    return docReader -> new FilterScript(params, lookup, docReader) {
                        @Override
                        public boolean execute() {
                            var roles = getDoc().get("qualifier_role");
                            if (roles == null || roles.size() != 1) {
                                throw new IllegalArgumentException("exactly one qualifier_role keyword value required");
                            }
                            String role = String.valueOf(roles.get(0));
                            if (!Set.of("healthy", "slow", "fail").contains(role)) {
                                throw new IllegalArgumentException("unsupported qualifier_role");
                            }
                            long started = System.nanoTime();
                            probe.event("entered", role, mode, started, null);
                            try {
                                if ("fail".equals(role) && ("fail".equals(mode) || "mixed".equals(mode))) {
                                    throw new IllegalStateException("injected qualification shard failure: " + probeKey);
                                }
                                if ("slow".equals(role) && !"fail".equals(mode) && delayed.compareAndSet(false, true)) {
                                    probe.beginDelay();
                                    try {
                                        long end = started + delayNanos;
                                        do {
                                            // The late mode intentionally skips cooperative checks for <=2 seconds.
                                            // It exists only to measure late completion after a client response.
                                            if (!"late".equals(mode)) {
                                                Runnable cancellation = _getCancellationCheck();
                                                if (cancellation != null) cancellation.run();
                                            }
                                            LockSupport.parkNanos(Math.min(5_000_000L, Math.max(0, end - System.nanoTime())));
                                        } while (System.nanoTime() < end);
                                        if (!"late".equals(mode)) {
                                            Runnable cancellation = _getCancellationCheck();
                                            if (cancellation != null) cancellation.run();
                                        }
                                    } finally { probe.endDelay(); }
                                }
                                probe.event("completed", role, mode, started, null);
                                return true;
                            } catch (RuntimeException | Error error) {
                                String type = error.getClass().getName();
                                // A query deadline is not evidence that an Elasticsearch task was cancelled.
                                String event = error instanceof TaskCancelledException ? "task_cancelled"
                                    : error instanceof ContextIndexSearcher.TimeExceededException ? "query_timed_out" : "failed";
                                probe.event(event, role, mode, started, type);
                                throw error;
                            }
                        }
                    };
                };
                return context.factoryClazz.cast(factory);
            }
        };
    }

    @Override
    public Collection<RestHandler> getRestHandlers(RestHandlersServices services,
            Supplier<DiscoveryNodes> nodes, Predicate<NodeFeature> feature) {
        return List.of(new BaseRestHandler() {
            @Override public String getName() { return "hyperion_qualifier_state"; }
            @Override public List<Route> routes() {
                return List.of(new Route(RestRequest.Method.GET, "/_hyperion_qualifier/state"),
                    new Route(RestRequest.Method.POST, "/_hyperion_qualifier/reset"));
            }
            @Override
            protected RestChannelConsumer prepareRequest(RestRequest request, NodeClient client) {
                String raw = request.param("key");
                String probeKey = raw == null ? null : key(raw);
                boolean reset = request.path().endsWith("/reset");
                if (request.method() == RestRequest.Method.POST && probeKey == null) {
                    throw new IllegalArgumentException("mutation requires an exact key");
                }
                Map<String, Object> result = snapshot(probeKey, reset);
                return channel -> channel.sendResponse(new RestResponse(RestStatus.OK, channel.newBuilder().map(result)));
            }
        });
    }

    @Override
    public List<QuerySpec<?>> getQueries() {
        return List.of(new QuerySpec<>(RewriteTimeout.NAME, RewriteTimeout::new, RewriteTimeout::parse));
    }

    /** Mirrors Elasticsearch's SearchTimeoutIT early-timeout fixture, never a natural timing claim. */
    public static final class RewriteTimeout extends AbstractQueryBuilder<RewriteTimeout> {
        static final String NAME = "hyperion_qualifier_timeout";
        private final String indexSuffix;
        public RewriteTimeout() { this((String) null); }
        private RewriteTimeout(String indexSuffix) { this.indexSuffix = indexSuffix; }
        public RewriteTimeout(StreamInput in) throws IOException { super(in); indexSuffix = in.readOptionalString(); }
        static RewriteTimeout parse(XContentParser parser) throws IOException {
            Map<String, Object> params = parser.map();
            if (params.isEmpty()) return new RewriteTimeout();
            if (params.size() == 1 && "-slow".equals(params.get("index_suffix"))) return new RewriteTimeout("-slow");
            throw new IllegalArgumentException(NAME + " accepts only {} or {index_suffix:'-slow'}");
        }
        @Override public String getWriteableName() { return NAME; }
        @Override public TransportVersion getMinimalSupportedVersion() { return TransportVersion.current(); }
        @Override protected void doWriteTo(StreamOutput out) throws IOException { out.writeOptionalString(indexSuffix); }
        @Override protected void doXContent(XContentBuilder builder, Params params) throws IOException {
            builder.startObject(NAME);
            if (indexSuffix != null) builder.field("index_suffix", indexSuffix);
            builder.endObject();
        }
        @Override protected boolean doEquals(RewriteTimeout other) { return java.util.Objects.equals(indexSuffix, other.indexSuffix); }
        @Override protected int doHashCode() { return java.util.Objects.hashCode(indexSuffix); }
        @Override
        protected Query doToQuery(SearchExecutionContext context, MaxClauseCountQueryVisitor visitor) {
            context.disableCache();
            String indexName = context.index().getName();
            if (!indexName.startsWith("hyp-es955-")) {
                throw new IllegalArgumentException("qualification timeout requires a hyp-es955- index");
            }
            if (indexSuffix != null && !indexName.endsWith(indexSuffix)) return MatchAllDocsQuery.INSTANCE;
            return new Query() {
                @Override public Query rewrite(IndexSearcher searcher) {
                    ((ContextIndexSearcher) searcher).throwTimeExceededException();
                    throw new AssertionError("throwTimeExceededException must throw");
                }
                @Override public String toString(String field) { return NAME; }
                @Override public void visit(QueryVisitor visitor) { visitor.visitLeaf(this); }
                @Override public boolean equals(Object other) { return sameClassAs(other); }
                @Override public int hashCode() { return classHash(); }
            };
        }
    }
}
