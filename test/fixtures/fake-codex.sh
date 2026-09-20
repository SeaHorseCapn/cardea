#!/bin/bash
# Emits codex-exec-style JSONL regardless of args; reads stdin like the real thing.
cat > /dev/null
echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"turn.started"}'
echo '{"type":"item.completed","item":{"type":"agent_message","text":"FAKE CODEX ANSWER"}}'
echo '{"type":"turn.completed"}'
