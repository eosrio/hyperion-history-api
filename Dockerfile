FROM gcr.io/voice-dev-infra-services/voice/hyperion-explorer-plugin:latest as explorer
FROM gcr.io/voice-dev-infra-services/voice/hyperion-simpleassets-plugin:latest as sa

FROM gcr.io/voice-ops-dev/alpine-node:16
ARG NPM_AUTH_TOKEN
USER root
RUN apk add jq && npm install pm2@latest -g
USER voice
COPY --chown=voice:voice . .
RUN mv .npmrc.template .npmrc && \
 npm ci && \
 rm .npmrc
COPY --chown=voice:voice --from=explorer /opt/app/ /opt/app/plugins/repos/explorer
COPY --chown=voice:voice --from=sa /opt/app/ /opt/app/plugins/repos/simpleasssests
RUN ./hpm enable explorer && ./hpm enable simpleasssests
EXPOSE 7000
