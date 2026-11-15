#!/bin/bash
# Геометрия линий метро/МЦК/МЦД и станции (с названиями) из Overpass → raw/metro.json
cd ~/moscow-reach
Q='[out:json][timeout:300];
rel["type"="route"]["route"="subway"](55.1,36.8,56.05,38.05)->.s;
rel["type"="route"]["route"="train"]["network"~"МЦК|МЦД|Московск"](55.1,36.8,56.05,38.05)->.t;
(.s;.t;)->.r;
.r out geom;
node(r.r);
out;'
for i in 1 2 3 4 5 6 7 8; do
  curl -s --max-time 280 -A "moscow-reach-hobby/0.1" -H "Accept: */*" -o raw/metro.tmp --data-urlencode "data=$Q" https://overpass-api.de/api/interpreter
  if head -c 1 raw/metro.tmp | grep -q '{' && ! grep -q '"remark"' raw/metro.tmp; then mv raw/metro.tmp raw/metro.json; echo ok; exit 0; fi
  echo retry $i; sleep 25
done; echo FAILED; exit 1
