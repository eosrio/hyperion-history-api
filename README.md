# Voice's Hyperion History API

This is a forked implementation of [EOSRIO's hyperion-history-api](https://github.com/eosrio/hyperion-history-api) to suit the specific needs of a block explorer for Voice.

## Running Locally

1. `npm install`
1. `npm run generate-skaffold`
1. `npm run start-skaffold`
1. Wait till all the pods and services are running, then: `kubectl port-forward voice-eos-hyperion-api 7000:7000`
1. Visit `localhost:7000/v2/explore/` to get to the Hyperion API homepage
    1. You can also visit `localhost:7000/v2/docs` to access the Swagger API documentation

<img alt="hyperion logo" height="64" src="https://eosrio.io/hyperion.png">
<br/>
Scalable Full History API Solution for EOSIO based blockchains

Made with ♥ by [EOS Rio](https://eosrio.io/)

Official documentation: https://hyperion.docs.eosrio.io/

### 1. Overview

Hyperion is a full history solution for indexing, storing and retrieving EOSIO blockchain`s historical data. EOSIO protocol is highly scalable reaching up to tens of thousands of transactions per second demanding high performance indexing and optimized storage and querying solutions. Hyperion is developed to tackle those challenges providing open source software to be operated by block producers, infrastructure providers and dApp developers.

Focused on delivering faster search times, lower bandwidth overhead and easier usability for UI/UX developers, Hyperion implements an improved data structure
actions are stored in a flattened format
a parent field is added to the inline actions to point to the parent global sequence
if the inline action data is identical to the parent it is considered a notification and thus removed from the database
no blocks or transaction data is stored, all information can be reconstructed from actions


### 2. Architecture
The following components are required in order to have a fully functional Hyperion API deployment,
for small use cases its absolutely fine to run all components on a single machine. For larger chains and
production environments we recommend setting them up into different servers under a high-speed local network.

#### 2.1 Elasticsearch Cluster
The ES cluster is responsible for storing all indexed data.
Direct access to the Hyperion API and Indexer must be provided. We recommend nodes in the
cluster to have at least 32 GB of RAM and 8 cpu cores. SSD/NVME drives are recommended for
maximum indexing throughput. For production environments a multi-node cluster is highly recommended.

#### 2.2 Hyperion Indexer
The Indexer is a Node.js based app that process data from the state history plugin and allows it to be indexed.
The PM2 process manager is used to launch and operate the indexer. The configuration flexibility is very extensive,
so system recommendations will depend on the use case and data load. It will require access to at least one ES node,
RabbitMQ and the state history node.

#### 2.3 Hyperion API
Parallelizable API server that provides the V2 and V1 (legacy history plugin) endpoints.
It is launched by PM2 and can also operate in cluster mode. It requires direct access to
at least one ES node for the queries and all other services for full healthcheck

#### 2.4 RabbitMQ
Use as messaging queue and data transport between the indexer stages

#### 2.5 EOSIO State History
Nodeos plugin used to collect action traces and state deltas. Provides data via websocket to the indexer

### 3. How to use

#### 3.1 [For Providers](https://eosrio.github.io/hyperion-docs/quickstart/)

#### 3.2 [For Developers](https://eosrio.github.io/hyperion-docs/howtouse/)
