FROM node:12.9-alpine

RUN apk add netcat-openbsd
RUN apk add git
RUN apk --no-cache add --virtual native-deps \
  g++ gcc libgcc libstdc++ linux-headers make python

RUN mkdir -p /root/app/
WORKDIR /root/app/

RUN git clone https://github.com/eosrio/Hyperion-History-API.git

WORKDIR /root/app/Hyperion-History-API

RUN npm install pm2 -g && npm install

EXPOSE 7000

#CMD pm2-runtime ecosystem.config.json --only API --update-env
