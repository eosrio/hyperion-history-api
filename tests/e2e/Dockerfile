# Hyperion E2E Test Suite — nodeos + CDT Builder
# Multi-stage build:
#   Stage 1: Install CDT + build reference-contracts + custom test contracts
#   Stage 2: Install Spring (nodeos) + copy compiled contracts

ARG SPRING_VERSION=1.2.2
ARG CDT_VERSION=4.1.1
ARG UBUNTU_VERSION=22.04

# ============================================================
# Stage 1: CDT + Contract Builder
# ============================================================
FROM ubuntu:${UBUNTU_VERSION} AS builder

ARG CDT_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    wget \
    cmake \
    build-essential \
    git \
    && rm -rf /var/lib/apt/lists/*

# Install CDT from .deb (note: -1 suffix in filename is part of the deb naming)
RUN wget -q "https://github.com/AntelopeIO/cdt/releases/download/v${CDT_VERSION}/cdt_${CDT_VERSION}-1_amd64.deb" -O /tmp/cdt.deb \
    && dpkg -i /tmp/cdt.deb || true \
    && apt-get update && apt-get install -f -y \
    && rm /tmp/cdt.deb \
    && rm -rf /var/lib/apt/lists/*

# Verify CDT installation
RUN cdt-cpp --version

# Build reference-contracts from source
# CDT cmake files are at /usr/lib/cmake/cdt/ after deb install
WORKDIR /build
RUN git clone --recursive https://github.com/AntelopeIO/reference-contracts.git \
    && cd reference-contracts \
    && mkdir build && cd build \
    && cmake -DCMAKE_BUILD_TYPE=Release \
             -Dcdt_DIR=/usr/lib/cmake/cdt \
             .. \
    && make -j$(nproc)

# Build custom test contracts (added later via COPY)
WORKDIR /build/hyp-test-contracts
COPY contracts/ ./
RUN if [ -f "hyp.test.cpp" ]; then \
        cdt-cpp -abigen --contract=hyptest -o hyptest.wasm hyp.test.cpp \
        && mv hyptest.wasm hyp.test.wasm \
        && mv hyptest.abi hyp.test.abi \
        && rm -f .gitkeep; \
    fi

# ============================================================
# Stage 2: Runtime — nodeos + contracts
# ============================================================
FROM ubuntu:${UBUNTU_VERSION} AS runtime

ARG SPRING_VERSION

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y \
    wget \
    curl \
    jq \
    && rm -rf /var/lib/apt/lists/*

# Install Spring (nodeos) from .deb
RUN wget -q "https://github.com/AntelopeIO/spring/releases/download/v${SPRING_VERSION}/antelope-spring_${SPRING_VERSION}_amd64.deb" -O /tmp/spring.deb \
    && dpkg -i /tmp/spring.deb || true \
    && apt-get update && apt-get install -f -y \
    && rm /tmp/spring.deb \
    && rm -rf /var/lib/apt/lists/*

# Verify nodeos installation
RUN nodeos --version

# Copy compiled system contracts from builder
COPY --from=builder /build/reference-contracts/build/contracts/ /contracts/system/

# Copy custom test contracts from builder (if any)
COPY --from=builder /build/hyp-test-contracts/ /contracts/custom/

# Create data directories
RUN mkdir -p /data/nodeos /config

# Copy nodeos configuration
COPY nodeos/config.ini /config/config.ini
COPY nodeos/genesis.json /config/genesis.json

# Bootstrap script for first-run initialization
COPY nodeos/start.sh /start.sh
RUN chmod +x /start.sh

EXPOSE 8888 8080

ENTRYPOINT ["/start.sh"]
