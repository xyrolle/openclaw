import json, sys
for r in json.load(open(sys.argv[1])):
    print(f"{r['agent']:9} {r['scenario']:13} wait={r['waitStatus']} req={r['providerRequests']} toolres={r['toolResultRequests']} "
          f"provider first/last/end={r['firstProviderDeltaMs']}/{r['lastProviderDeltaMs']}/{r['providerEndMs']} "
          f"client n/first/last={r['clientDeltaCount']}/{r['firstClientDeltaMs']}/{r['lastClientDeltaMs']}")
    print(f"           terminal={r['terminalChat']}")
    print(f"           withdrawals={r['withdrawals'][:4]} history refused/call1/call2={r['historyHasRefusedPartial']}/{r['historyHasCallOne']}/{r['historyHasCallTwoPartial']} files={r['workspaceFiles']}")
    print(f"           toolResults={r.get('toolResults')} toolEvents={r.get('toolEvents')} thinkingWithdrawals={r.get('thinkingWithdrawals')}")
