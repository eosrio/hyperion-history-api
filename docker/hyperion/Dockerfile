FROM ubuntu:18.04

RUN apt-get update
RUN apt-get upgrade
RUN apt-get autoremove

RUN apt-get install -y build-essential
RUN apt-get install -y git
RUN apt-get install -y curl
RUN apt-get install -y netcat

WORKDIR /root

RUN curl -sL https://deb.nodesource.com/setup_14.x | bash -
RUN apt-get install -y nodejs

RUN git clone https://github.com/eosrio/hyperion-history-api.git

WORKDIR /root/hyperion-history-api

RUN npm install pm2 -g
RUN npm install --unsafe-perm

EXPOSE 7001
