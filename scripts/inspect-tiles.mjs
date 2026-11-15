import fs from 'node:fs';
import { PMTiles } from 'pmtiles';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
const file = process.argv[2];
const fh = fs.openSync(file, 'r');
const source = { getKey: () => file, getBytes: async (off, len) => { const b = Buffer.alloc(len); fs.readSync(fh, b, 0, len, off); return { data: b.buffer.slice(b.byteOffset, b.byteOffset + len) }; } };
const p = new PMTiles(source);
console.log(JSON.stringify(await p.getHeader()).slice(0, 400));
// тайл z15 в центре Москвы
const z = 15, n = 2 ** z, lon = 37.6176, lat = 55.7558;
const x = Math.floor(((lon + 180) / 360) * n);
const y = Math.floor(((1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
const t = await p.getZxy(z, x, y);
const vt = new VectorTile(new Pbf(t.data));
console.log('layers', Object.keys(vt.layers));
for (const name of ['roads', 'water', 'earth', 'landuse']) {
  const L = vt.layers[name]; if (!L) continue;
  const kinds = {}; 
  for (let i = 0; i < L.length; i++) { const f = L.feature(i); const k = [f.type, f.properties.kind, f.properties.kind_detail, f.properties.is_bridge ? 'bridge' : '', f.properties.is_tunnel ? 'tunnel' : '', f.properties.level ?? ''].join('|'); kinds[k] = (kinds[k] || 0) + 1; }
  console.log(name, L.length, 'extent', L.extent); console.log(Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 25));
}
const f = vt.layers.roads.feature(0); console.log('props sample', f.properties);
