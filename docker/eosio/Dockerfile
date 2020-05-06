FROM ubuntu:18.04

RUN apt-get update
RUN apt-get upgrade
RUN apt-get autoremove

RUN apt-get install -y wget
RUN apt-get install -y netcat

WORKDIR /root

RUN wget -nv https://github.com/eosio/eos/releases/download/v2.0.5/eosio_2.0.5-1-ubuntu-18.04_amd64.deb
RUN apt-get install -y ./eosio_2.0.5-1-ubuntu-18.04_amd64.deb
RUN rm ./eosio_2.0.5-1-ubuntu-18.04_amd64.deb

EXPOSE 8080
