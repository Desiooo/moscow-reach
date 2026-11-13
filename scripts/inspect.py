import json,sys,collections
for n in ['subway','train','tram','trolley','bus']:
    d=json.load(open(f'raw/{n}.json'))
    rels=[e for e in d['elements'] if e['type']=='relation']
    nodes={e['id'] for e in d['elements'] if e['type']=='node'}
    withiv=sum(1 for r in rels if 'interval' in r.get('tags',{}))
    roles=collections.Counter(m['role'] for r in rels for m in r['members'] if m['type']=='node')
    nets=collections.Counter(r['tags'].get('network','-') for r in rels).most_common(5)
    print(n,len(rels),'rels',len(nodes),'nodes','interval:',withiv)
    print('  roles',roles.most_common(6)); print('  nets',nets)
    print('  sample',rels[0]['tags'].get('name'), rels[0]['tags'].get('ref'))
