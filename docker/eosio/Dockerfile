FROM ubuntu:20.04
LABEL version="2.1.0" description="EOSIO 2.1.0"
RUN apt-get update && apt-get install -y wget
RUN wget -nv https://github.com/EOSIO/eos/releases/download/v2.1.0/eosio_2.1.0-1-ubuntu-20.04_amd64.deb
RUN apt-get install -y ./eosio_2.1.0-1-ubuntu-20.04_amd64.deb && rm -f ./eosio_2.1.0-1-ubuntu-20.04_amd64.deb
