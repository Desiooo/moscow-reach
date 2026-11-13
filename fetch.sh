#!/bin/bash
# usage: fetch.sh name 'filter'
cd ~/moscow-reach/raw
name=$1; filt=$2
Q="[out:json][timeout:500];rel[\"type\"=\"route\"]$filt(55.45,37.2,56.0,38.0)->.r;.r out body;node(r.r);out skel qt;"
for i in 1 2 3 4 5 6 7 8; do
  curl -s --max-time 550 -A "moscow-reach-hobby/0.1" -H "Accept: */*" -o $name.tmp --data-urlencode "data=$Q" https://overpass-api.de/api/interpreter
  if head -c 1 $name.tmp | grep -q '{' && ! grep -q '"remark"' $name.tmp; then mv $name.tmp $name.json; echo "$name ok"; exit 0; fi
  echo "$name retry $i"; sleep 30
done
echo "$name FAILED"; exit 1
