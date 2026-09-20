#!/bin/bash
# Emits claude -p stream-json shapes; always classifies as "fast".
cat > /dev/null
echo '{"type":"system","subtype":"init"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"fast"}]}}'
echo '{"type":"result","subtype":"success","result":"fast","total_cost_usd":0.001}'
