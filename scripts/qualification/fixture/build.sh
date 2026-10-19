#!/usr/bin/env bash
set -euo pipefail
# Run only in the exact digest-pinned ES 9.5.5 image with this directory at /fixture
# and a new, writable /output mount. No dependency download or running node is needed.
test "$(/usr/share/elasticsearch/jdk/bin/java -version 2>&1 | head -n 1)" = 'openjdk version "27" 2026-09-15'
test -f /usr/share/elasticsearch/lib/elasticsearch-9.5.5.jar
test ! -e /output/hyperion-qualifier.jar
test ! -e /output/classes
mkdir -p /output/classes
/usr/share/elasticsearch/jdk/bin/javac -Xlint:all -Werror \
  -cp '/usr/share/elasticsearch/lib/*' \
  -d /output/classes /fixture/HyperionQualifierPlugin.java
/usr/share/elasticsearch/jdk/bin/jar --create --date=2026-10-19T00:00:00Z \
  --file /output/hyperion-qualifier.jar -C /output/classes .
cp /fixture/plugin-descriptor.properties /output/plugin-descriptor.properties
printf '%s\n' 'Compiled Hyperion disposable fault fixture against ES 9.5.5 / Java 27.'
