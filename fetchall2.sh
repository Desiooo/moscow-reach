#!/bin/bash
cd ~/moscow-reach
./fetch2.sh subway '["route"="subway"]'
./fetch2.sh lightrail '["route"~"light_rail|monorail"]'
./fetch2.sh train '["route"="train"]["network"~"МЦК|МЦД|Московск"]'
./fetch2.sh tram '["route"="tram"]'
./fetch2.sh trolley '["route"="trolleybus"]'
./fetch2.sh bus '["route"="bus"]'
echo ALLDONE
