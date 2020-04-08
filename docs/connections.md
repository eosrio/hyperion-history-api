#### Detailed description of the connections.json

````json
{
   "amqp":{ --> RabbitMQ parameters
      "host":"127.0.0.1:5672",
      "api":"127.0.0.1:15672",
      "user":"my_user",
      "pass":"my_password",
      "vhost":"hyperion"
   },
   "elasticsearch":{ --> Elasticsearch parameters
      "host":"127.0.0.1:9200",
      "ingest_nodes":[
         "127.0.0.1:9200"
      ],
      "user":"",
      "pass":""
   },
   "redis":{ --> Redis parameters
      "host":"127.0.0.1",
      "port":"6379"
   },
   "chains":{ --> Chain Parameters
      "eos":{
         "name":"EOS Mainnet",
         "chain_id":"aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906",
         "http":"http://127.0.0.1:8888",
         "ship":"ws://127.0.0.1:8080",
         "WS_ROUTER_PORT":7001
      }
   }
}
````
#### Example:
In this example we have an connection.json file with:

  - Local RabbitMQ
      - user: admin
      - pass: 123456
  - Local Elasticsearch
      - no user
      - no password
  - Local Reddis
  - Remote EOS Mainnet state history
  - Remote WAX state history

The first step is to make a copy of the config file and rename it: `example-connections.json` to `connections.json`.
The next step is to edit the file as the following:

````json
{
  "amqp": {
    "host": "127.0.0.1:5672",
    "api": "127.0.0.1:15672",
    "user": "admin",
    "pass": "123456",
    "vhost": "hyperion"
  },
  "elasticsearch": {
    "host": "127.0.0.1:9200",
    "ingest_nodes": ["127.0.0.1:9200"],
    "user": "",
    "pass": ""
  },
  "redis": {
    "host": "127.0.0.1",
    "port": "6379"
  },
  "chains": {
    "eos": {
      "name": "EOS Mainnet",
      "chain_id": "aca376f206b8fc25a6ed44dbdc66547c36c6c33e3a119ffbeaef943642f0e906",
      "http": "http://127.0.0.1:8888",
      "ship": "ws://127.0.0.1:8080",
      "WS_ROUTER_PORT": 7001
    },
    "sample": {
      "name": "Sample Mainnet",
      "chain_id": "9473887b3cd1a897ce03ae5b6a865651747e2e152090f99c1d19d4adf73238fas",
      "http": "https://sample.io",
      "ship": "ws://192.168.0.1:8080",
      "WS_ROUTER_HOST": "127.0.0.1",
      "WS_ROUTER_PORT": 8034
    }
  }
}
````