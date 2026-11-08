#!/usr/bin/env bash
# Builds and runs the host tests for the portable firmware logic (g++/clang++).
set -euo pipefail
cd "$(dirname "$0")/.."
CXX="${CXX:-g++}"
mkdir -p build
"$CXX" -std=c++17 -O2 -Wall -Wextra -I sketch \
  tools/host_test.cpp sketch/fall_detector.cpp sketch/orientation.cpp \
  -o build/host_test
./build/host_test
