#!/usr/bin/env bash
set -euo pipefail
# Offline internal component check. Uses production classes from the exact ES image.
test "$(/usr/share/elasticsearch/jdk/bin/java -version 2>&1 | head -n 1)" = 'openjdk version "27" 2026-09-15'
test -f /usr/share/elasticsearch/lib/elasticsearch-9.5.5.jar
test ! -e /output/internal-classes
mkdir -p /output/internal-classes
/usr/share/elasticsearch/jdk/bin/javac -Xlint:all -Werror \
  -cp '/usr/share/elasticsearch/lib/*' \
  -d /output/internal-classes /fixture/HyperionLateResultCheck.java
/usr/share/elasticsearch/jdk/bin/java -ea \
  -cp '/output/internal-classes:/usr/share/elasticsearch/lib/*' \
  org.elasticsearch.action.search.HyperionLateResultCheck
