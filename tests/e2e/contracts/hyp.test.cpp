#include <eosio/eosio.hpp>
#include <eosio/asset.hpp>
#include <eosio/system.hpp>

using namespace eosio;

/**
 * Hyperion E2E Test Contract
 *
 * Provides custom actions designed to exercise Hyperion's indexer
 * capabilities beyond what system contracts cover:
 *   - Nested inline actions (depth testing)
 *   - Large data payloads (deserialization stress)
 *   - Table deltas (contract_state tracking)
 *   - Notification patterns (multi-receiver indexing)
 */
CONTRACT hyptest : public contract {
public:
    using contract::contract;

    // ─── Table for delta tracking ──────────────────────────────

    TABLE datastore {
        uint64_t    id;
        name        owner;
        std::string key;
        std::string value;
        uint64_t    updated_at;

        uint64_t primary_key() const { return id; }
        uint64_t by_owner() const { return owner.value; }
    };
    typedef eosio::multi_index<"datastore"_n, datastore,
        indexed_by<"byowner"_n, const_mem_fun<datastore, uint64_t, &datastore::by_owner>>
    > datastore_table;

    TABLE counter {
        name     account;
        uint64_t count;

        uint64_t primary_key() const { return account.value; }
    };
    typedef eosio::multi_index<"counters"_n, counter> counter_table;

    // ─── Actions ───────────────────────────────────────────────

    /**
     * Store arbitrary key-value data.
     * Generates table deltas for contract_state tracking.
     */
    ACTION storedata(name owner, std::string key, std::string value) {
        require_auth(owner);

        datastore_table store(get_self(), get_self().value);
        store.emplace(owner, [&](auto& row) {
            row.id = store.available_primary_key();
            row.owner = owner;
            row.key = key;
            row.value = value;
            row.updated_at = current_time_point().sec_since_epoch();
        });
    }

    /**
     * Update existing data entry.
     * Generates delta updates (not inserts).
     */
    ACTION updatedata(name owner, uint64_t id, std::string value) {
        require_auth(owner);

        datastore_table store(get_self(), get_self().value);
        auto itr = store.find(id);
        check(itr != store.end(), "data entry not found");
        check(itr->owner == owner, "not the owner");

        store.modify(itr, owner, [&](auto& row) {
            row.value = value;
            row.updated_at = current_time_point().sec_since_epoch();
        });
    }

    /**
     * Delete data entry.
     * Generates delta deletes.
     */
    ACTION erasedata(name owner, uint64_t id) {
        require_auth(owner);

        datastore_table store(get_self(), get_self().value);
        auto itr = store.find(id);
        check(itr != store.end(), "data entry not found");
        check(itr->owner == owner, "not the owner");

        store.erase(itr);
    }

    /**
     * Trigger nested inline actions up to a given depth.
     * Tests Hyperion's inline action indexing at various depths.
     */
    ACTION nestaction(name triggerer, uint8_t depth, uint8_t current_depth, std::string memo) {
        require_auth(get_self());

        if (current_depth < depth) {
            action(
                permission_level{get_self(), "active"_n},
                get_self(),
                "nestaction"_n,
                std::make_tuple(triggerer, depth, (uint8_t)(current_depth + 1), memo)
            ).send();
        }

        // Log at each level for verification
        action(
            permission_level{get_self(), "active"_n},
            get_self(),
            "nestlog"_n,
            std::make_tuple(triggerer, current_depth, memo)
        ).send();
    }

    ACTION nestlog(name triggerer, uint8_t level, std::string memo) {
        require_auth(get_self());
        // Intentionally empty — exists for indexing verification
    }

    /**
     * Send notifications to multiple accounts.
     * Tests Hyperion's notified account tracking.
     */
    ACTION notify(name sender, std::vector<name> recipients, std::string message) {
        require_auth(sender);

        for (const auto& r : recipients) {
            require_recipient(r);
        }
    }

    /**
     * Increment a counter for an account.
     * Simple delta-generating action for repetitive load testing.
     */
    ACTION increment(name account) {
        require_auth(get_self());

        counter_table counts(get_self(), get_self().value);
        auto itr = counts.find(account.value);

        if (itr == counts.end()) {
            counts.emplace(get_self(), [&](auto& row) {
                row.account = account;
                row.count = 1;
            });
        } else {
            counts.modify(itr, get_self(), [&](auto& row) {
                row.count += 1;
            });
        }
    }

    /**
     * Store a large payload.
     * Stress tests ABI deserialization with configurable data size.
     */
    ACTION bigpayload(name sender, std::string data) {
        require_auth(sender);
        // data can be arbitrarily large — just store the hash as proof
        check(data.size() > 0, "data must not be empty");
    }
};
