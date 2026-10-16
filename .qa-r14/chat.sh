#!/bin/bash
# usage: chat.sh <businessId> <userId> <conversationId> <text> [modelKey] [suggestionId]
B="$1"; U="$2"; C="$3"; T="$4"; M="${5:-}"; S="${6:-}"
BODY=$(jq -n --arg b "$B" --arg u "$U" --arg c "$C" --arg t "$T" --arg m "$M" --arg s "$S" '{businessId:$b,userId:$u,conversationId:$c,text:$t} + (if $m!="" then {modelKey:$m} else {} end) + (if $s!="" then {suggestionId:$s} else {} end)')
START=$(date +%s%3N)
curl -s -N -m 120 -X POST http://localhost:3000/api/chat -H 'content-type: application/json' -d "$BODY" > .qa-r14/last.sse
END=$(date +%s%3N)
echo "TOTAL_MS: $((END-START))"
python3 - <<'PY'
import sys, json
sys.stdout.reconfigure(errors="replace")
events = []
deltas = 0
text = ''
for line in open('.qa-r14/last.sse'):
    line = line.strip()
    if not line.startswith('data: '): continue
    try: d = json.loads(line[6:])
    except: continue
    ev = d.get('event')
    if ev == 'delta':
        deltas += 1
        text += d.get('text','')
        continue
    if ev == 'thinking':
        steps = [f"[{s.get('state')}] {s.get('label')}" for s in d.get('steps',[])]
        events.append('thinking: ' + ' | '.join(steps))
    elif ev == 'step':
        events.append(f"step: {d.get('label')} [{d.get('state')}]")
    elif ev == 'card':
        c = d.get('card',{})
        events.append(f"card: {c.get('ref')} {c.get('title')} risk={c.get('risk')} danger={bool(c.get('dangerNote'))}")
        events.append(f"  summary: {c.get('summary')}")
        for f in (c.get('fields') or []):
            events.append(f"  field: {f.get('label')} = {f.get('value')}" + (f" (hint: {f.get('hint')})" if f.get('hint') else ''))
    elif ev == 'cards':
        for c in d.get('cards',[]):
            events.append(f"cards+ : {c.get('kind')} «{c.get('title')}» rows={len(c.get('rows',[]))} footer={c.get('footer')}")
    elif ev == 'actions':
        events.append('actions: ' + ' , '.join(f"{a.get('label')}→{a.get('view')}({a.get('tone')})" for a in d.get('actions',[])))
    elif ev == 'done':
        events.append(f"done: {d.get('messageId')} model={d.get('modelLabel')}")
    elif ev == 'error':
        events.append(f"ERROR: {d.get('message')}")
    else:
        events.append(f"{ev}: {json.dumps(d, ensure_ascii=False)[:200]}")
print(f"deltas: {deltas}")
print(f"reply ({len(text)} chars):")
print(text)
print("--- events ---")
for e in events: print(e)
PY
