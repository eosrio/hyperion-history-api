## build and push the image
```
    docker build -t hyperion:latest .
    docker tag hyperion:latest gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:latest
    docker rmi hyperion:latest
    docker push gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:latest
```


## Deployment
# If this is the first deployment or in case of a elastic search data wipe 
# If this is a just an update there is no need for the abi scan
1. make abi_scan true in the values file 
2. Install the helm chart.
    ```
    helm nstall voice-eos-hyperion  -f values/env.yaml . -n dev    --atomic --debug 
    ```
3. monitor the indexer 1st scan untill it finshes
4. make the bi_scan false in the values file 
5. upgrade the helm chart 
    ```
        helm upgrade --install voice-eos-hyperion  -f values/dev.yaml . -n dev  --atomic --debug 
    ```
5. restart the indexer once that is done.
```
    helm upgrade --install voice-eos-hyperion  -f values/dev.yaml voice-helm-repo -n hyperion    --atomic --debug
```