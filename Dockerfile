FROM ubuntu:20.04
# WORKDIR /opt
ARG NPM_AUTH_TOKEN
RUN apt-get update \
        && apt-get upgrade -y \
        && apt-get autoremove \
        && apt-get install -y build-essential git curl netcat && \
        # git clone https://github.com/eosrio/hyperion-history-api.git && \
        curl -sL https://deb.nodesource.com/setup_16.x | bash - && \
        apt-get install -y nodejs && npm install pm2@latest -g && \
        apt-get install -y jq

WORKDIR /hyperion-history-api
COPY . .
COPY .npmrc.template .npmrc 
RUN npm install  && \
      ./hpm install -r https://github.com/voice-social/hyperion-history-api.git explorer && \
      ./hpm enable explorer && \
      pm2 startup

RUN adduser --system --group voice && chown -R voice:voice /hyperion-history-api
USER voice
RUN  npm install

EXPOSE 7000
