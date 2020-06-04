FROM ubuntu:18.04

RUN apt-get update && apt-get upgrade -y && apt-get autoremove && apt-get install -y wget netcat

RUN wget -nv https://github.com/eosio/eos/releases/download/v2.0.5/eosio_2.0.5-1-ubuntu-18.04_amd64.deb
RUN apt-get install -y ./eosio_2.0.5-1-ubuntu-18.04_amd64.deb

RUN useradd -m -s /bin/bash eosio
USER eosio

EXPOSE 8080
