import json, sys
d = json.load(open(sys.argv[1]))
t0 = d['sentAt']
rows = []
for s in d['sends']:
    if s['type'] in ('content_block_delta', 'message_delta', 'message_stop'):
        rows.append((s['at'] - t0, 'provider', f"{s['type']} {s.get('delta') or ''} {s.get('stop') or ''} {(s.get('text') or '')[:40]!r}"))
for e in d['events']:
    p = e['payload']
    if e['event'] == 'agent':
        data = p.get('data') or {}
        if p.get('stream') in ('assistant', 'thinking'):
            rows.append((e['at'] - t0, f"agent:{p['stream']}", f"item={data.get('itemId')} replace={data.get('replace')} delta={(data.get('delta') or '')[:40]!r} text={(data.get('text') or '')[:50]!r}"))
        elif p.get('stream') == 'lifecycle':
            rows.append((e['at'] - t0, 'agent:lifecycle', f"{data.get('phase')} {str(data.get('error') or '')[:60]}"))
    elif p.get('state') in ('delta', 'error', 'final', 'aborted'):
        msg = p.get('message') or {}
        text = ''.join(c.get('text', '') for c in (msg.get('content') or []) if isinstance(c, dict))
        rows.append((e['at'] - t0, f"chat:{p['state']}", f"text={text[:60]!r} errorKind={p.get('errorKind')} {str(p.get('errorMessage') or '')[:50]}"))
for r in sorted(rows, key=lambda r: r[0]):
    print(f"{r[0]:>7} ms  {r[1]:<16} {r[2]}")
