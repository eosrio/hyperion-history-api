
## HTTP API Test Suite

The tests are written for the [JetBrains HTTP Client CLI](https://www.jetbrains.com/help/idea/http-client-cli.html)

```bash
curl -f -L -o ijhttp.zip "https://jb.gg/ijhttp/latest"
unzip ijhttp.zip
```

JDK 17 is required to run the HTTP Client CLI, make sure its installed.
```bash
sudo apt install openjdk-17-jdk-headless -y
```

If required please edit `http-client.env.json` according to your setup needs.

Running the tests
```bash
./ijhttp/ijhttp -r --env-file=http-client.env.json --env dev \
v1-chain-api.http \
v1-history-api.http \
v1-trace-api.http \
v2-api.http \
v2-history-api.http \
v2-state-api.http \
v2-stats-api.http
```

Note: push API endpoints such as push_transaction and send_transaction will not be tested by this suite
