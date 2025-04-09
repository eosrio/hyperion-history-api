<!--suppress HtmlUnknownTarget, HtmlDeprecatedAttribute -->
<br></br>
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://eosrio.io/hyperion-white.png">
    <img alt="Hyperion Logo"
         src="https://eosrio.io/hyperion.png">
  </picture>
</p>

<h4 align="center">
    Scalable Full History API Solution for 
    <a href="https://antelope.io">
        Antelope
    </a>
    (former EOSIO) based blockchains <br>
    ![CI](https://github.com/eosrio/hyperion-history-api/actions/workflows/build.yml/badge.svg)
</h4>

<br>

Made with ♥ by [Rio Blocks / EOS Rio](https://rioblocks.io/?lang=en)

![CI](https://github.com/eosrio/hyperion-history-api/actions/workflows/build.yml/badge.svg)

### 📖 [Hyperion Docs - Official Documentation](https://hyperion.docs.eosrio.io)

### How to use:

- [For Providers](https://hyperion.docs.eosrio.io/manual_installation/)

- [For Developers](https://hyperion.docs.eosrio.io/howtouse/)

### Official plugins:

- [Hyperion Lightweight Explorer](https://github.com/eosrio/hyperion-explorer-plugin)

### 1. Overview

Hyperion is a full history solution for indexing, storing and retrieving Antelope blockchain's historical data.
Antelope protocol is highly scalable reaching up to tens of thousands of transactions per second demanding high
performance indexing and optimized storage and querying solutions. Hyperion is developed to tackle those challenges
providing open source software to be operated by block producers, infrastructure providers and dApp developers.

Focused on delivering faster search times, lower bandwidth overhead and easier usability for UI/UX developers,
Hyperion implements an improved data structure. Actions are stored in a flattened format, transaction ids are added to
all inline actions, allowing to group by transaction without storing a full transaction index. Besides that if the
inline
action data is identical to the parent, it is considered a notification and thus removed from the database.
No full block or transaction data is stored, all information can be reconstructed from actions and deltas, only a block
header index is stored.

### 2. Architecture

The following components are required in order to have a fully functional Hyperion API deployment.

* For small use cases, it is absolutely fine to run all components on a single machine.
* For larger chains and production environments, we recommend setting them up into different servers under a high-speed
  local network.

#### 2.1 Elasticsearch Cluster

The ES cluster is responsible for storing all indexed data.
Direct access to the Hyperion API and Indexer must be provided. We recommend nodes in the
cluster to have at least 32 GB of RAM and 8 cpu cores. SSD/NVME drives are recommended for
maximum indexing throughput, although HDDs can be used for cold storage nodes.
For production environments, a multi-node cluster is highly recommended.

#### 2.2 Hyperion Indexer

The Indexer is a Node.js based app that process data from the state history plugin and allows it to be indexed.
The [PM2 process manager](https://pm2.keymetrics.io) is used to launch and operate the indexer. The configuration
flexibility is very extensive,
so system recommendations will depend on the use case and data load. It will require access to at least one ES node,
RabbitMQ and the state history node.

#### 2.3 Hyperion API

Parallelizable API server that provides the V2 and V1 (legacy history plugin) endpoints.
It is launched by PM2 and can also operate in cluster mode. It requires direct access to
at least one ES node for the queries and all other services for full healthcheck

#### 2.4 RabbitMQ

Used as messaging queue and data transport between the indexer stages and for real-time data streaming

#### 2.5 Redis

Used for transient data storage across processes and for the preemptive transaction caching used on
the `v2/history/get_transaction` and `v2/history/check_transaction` endpoints

#### 2.6 MongoDB

MongoDB serves as a specialized data store within Hyperion that fulfills several critical functions:

* **System Contract State Storage**: 
   - Stores searchable state data for Antelope system contracts like token balances, proposals, and voter information
   - Maintains three primary collections by default:
     - `accounts`: Stores token balances with indexes for code, scope, and symbol
     - `proposals`: Tracks governance proposals with detailed approval status
     - `voters`: Manages staking and voting records with optimized query paths

* **Custom Contract State Tracking**:
   - Supports operator-defined custom contracts and tables
   - Uses a flexible configuration system to define which contract tables to synchronize
   - Automatically creates appropriate indexes based on contract schemas
   - Stores tables in collections named `{contract}-{table}`

* **State Synchronization**:
   - Enables state synchronization even when starting from snapshots, providing a complete view of the blockchain state
   - Managed through the `hyp-control` CLI tool, allowing for targeted synchronization of specific contracts
   - Maintains block references to track state changes over time

* **Query Optimization**:
   - Creates specialized indexes based on common query patterns
   - Supports advanced query capabilities including MongoDB operators like `$gt`, `$lt`, `$in` for filters
   - Automatically handles date fields for time-based queries

* **API Integration**:
   - Provides dedicated API endpoints for querying state data
   - Supports endpoints like `/v2/state/get_tokens`, `/v2/state/get_proposals`, and `/v2/state/get_voters`
   - Offers flexible filtering options with pagination

* **Dynamic Contract Schema Support**:
   - Either automatically creates indexes based on contract ABIs
   - Or allows for manual index configuration for custom query patterns
   - Supports text search indexes for specific fields when configured

This MongoDB integration complements Elasticsearch by focusing on current state data rather than historical actions,
providing an optimized solution for applications that need to query the current blockchain state.

#### 2.7 AntelopeIO State History

[Spring / Leap / Nodeos](https://github.com/AntelopeIO/leap/tree/main/plugins/state_history_plugin) plugin used
to collect action traces and state deltas. Provides data via websocket to the indexer

#### 2.8 Hyperion Stream Client (optional)

Web and Node.js client for real-time streaming on enabled hyperion
providers. [Documentation](https://hyperion.docs.eosrio.io/dev/stream_client/)

#### 2.9 Hyperion Plugins (optional)

Hyperion includes a flexible plugin architecture to allow further customization.
Plugins are managed by the `hpm` (hyperion plugin manager) command line tool.
