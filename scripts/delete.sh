helm uninstall  voice-eos-hyperion-$branch -n $branch

kubectl delete namespace $branch
