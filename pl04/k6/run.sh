#!/bin/bash
# Runs the load test inside the Docker network of the cluster, through the Ingress
# (inside a container, localhost is the container itself, not your laptop).
# usage: bash k6/run.sh -e TARGET=tickets -e VUS=50 -e DURATION=10s -e CAPACITY=100
cd "$(dirname "$0")/.." || exit 1
docker run --rm --network k3d-cdn -v "$PWD/k6:/k6" \
  -e TICKETS_URL=http://k3d-cdn-serverlb/tickets \
  -e ORDERS_URL=http://k3d-cdn-serverlb/orders \
  "$@" grafana/k6 run --quiet /k6/flash-sale.js
