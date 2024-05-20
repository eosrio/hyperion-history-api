
## API Test Suite

The tests are written for the [JetBrain HTTP Client CLI](https://www.jetbrains.com/help/idea/http-client-cli.html)

```bash
sudo apt install openjdk-17-jdk-headless -y
curl -f -L -o ijhttp.zip "https://jb.gg/ijhttp/latest"
unzip ijhttp.zip
./ijhttp/ijhttp --env-file=http-client.env.json --env dev v1-chain-api.http v1-history-api.http v2-history-api.http v2-state-api.http v2-stats-api.http
```