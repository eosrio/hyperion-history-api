FROM gcr.io/voice-dev-infra-services/voice/hyperion-explorer-plugin:latest as explorer
FROM gcr.io/voice-dev-infra-services/voice/hyperion-simpleassets-plugin:latest as sa

FROM gcr.io/voice-ops-dev/alpine-node:16 as build
ARG NPM_AUTH_TOKEN
USER root
RUN apk add git
USER voice
COPY --chown=voice:voice . .
COPY --chown=voice:voice --from=explorer /opt/app/ /opt/app/plugins/repos/explorer
COPY --chown=voice:voice --from=sa /opt/app/ /opt/app/plugins/repos/simpleassests
RUN mv .npmrc.template .npmrc && \
    npm ci && \
    rm .npmrc && \
    find -type f -name '*.ts' -delete

RUN ./hpm enable explorer && ./hpm enable simpleassests

FROM gcr.io/voice-ops-dev/alpine-node:16
USER root
RUN apk add jq && npm install pm2@latest -g
USER voice
COPY --chown=voice:voice --from=build /opt/app /opt/app

EXPOSE 7000
