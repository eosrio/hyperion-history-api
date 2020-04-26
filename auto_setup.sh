#!/usr/bin/env bash
git clone https://github.com/eosrio/hyperion-history-api.git  || exit
cd hyperion-history-api || exit
bash ./install_env.sh
