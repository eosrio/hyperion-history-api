kubectl config use-context gke_voice-ops-dev_us-central1_voice-infra-devel

hash=$(git rev-parse HEAD)
/usr/local/bin/docker build -t hyperion:$hash .
/usr/local/bin/docker tag hyperion:$hash gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:$hash
/usr/local/bin/docker rmi hyperion:$hash

hash=$(git rev-parse HEAD)
/usr/local/bin/docker push gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:$hash
/usr/local/bin/docker tag gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:$hash gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:latest
/usr/local/bin/docker push gcr.io/voice-dev-infra-services/voice/voice-eos-hyperion:latest

branch=$(git branch | sed -n -e 's/^\* \(.*\)/\1/p')
kubectl create namespace $branch

helm upgrade --install voice-eos-hyperion-$branch  -f helm-chart/values/branch.yaml helm-chart/ -n $branch  --set tag=$hash    --atomic --debug 