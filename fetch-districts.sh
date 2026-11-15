#!/bin/bash
# Районы (admin_level=8) и округа (admin_level=5) Москвы из Overpass → raw/districts.json, raw/okrugs.json
cd ~/moscow-reach
get() { # name query
  for i in 1 2 3 4 5 6 7 8; do
    curl -s --max-time 280 -A "moscow-reach-hobby/0.1" -H "Accept: */*" -o raw/$1.tmp --data-urlencode "data=$2" https://overpass-api.de/api/interpreter
    if head -c 1 raw/$1.tmp | grep -q '{' && ! grep -q '"remark"' raw/$1.tmp; then mv raw/$1.tmp raw/$1.json; echo "$1 ok"; return 0; fi
    echo "$1 retry $i"; sleep 25
  done; echo "$1 FAILED"; return 1
}
get districts '[out:json][timeout:280];area(3600102269)->.m;rel(area.m)["boundary"="administrative"]["admin_level"="8"];out geom;'
get okrugs '[out:json][timeout:120];area(3600102269)->.m;rel(area.m)["boundary"="administrative"]["admin_level"="5"];out body;'
