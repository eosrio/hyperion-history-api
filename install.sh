#!/usr/bin/env bash

curl -sL https://deb.nodesource.com/setup_16.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install pm2 -g
npm install
