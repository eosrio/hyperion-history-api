#!/usr/bin/env bash
set -e

export NO_PROXY="${KUBERNETES_SERVICE_HOST}"

yarn global add @voice-social/voice-skaffold-tools@latest

voice-nuke-branch "$@"