#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=antigravity_cli
# HERDR_INTEGRATION_VERSION=4

# `session` runs on PreInvocation and reports the Antigravity conversation so
# Herdr can resume the pane. `reply` runs on Stop and reports the conversation
# again, then the turn's final reply. Lifecycle state comes from Herdr's screen
# detection.
#
# Subagents run inside the same Antigravity process and fire the same hooks
# with their own conversation. Both actions therefore report only the main
# conversation: the one whose transcript exists and starts with the user's
# input. A subagent's transcript starts with its parent's message and does not
# exist yet at its first PreInvocation.

set -eu

# Antigravity CLI expects a JSON object on stdout. This hook never injects
# steps or keeps a turn running, so every exit path emits an empty object.
emit_and_exit() {
  printf '{}\n'
  exit 0
}

case "${1:-}" in
  session|reply) ;;
  *) emit_and_exit ;;
esac
[ "${HERDR_ENV:-}" = "1" ] || emit_and_exit
[ -n "${HERDR_SOCKET_PATH:-}" ] || emit_and_exit
[ -n "${HERDR_PANE_ID:-}" ] || emit_and_exit
command -v python3 >/dev/null 2>&1 || emit_and_exit

python3 -c '
import json
import os
import socket
import sys
import time

source = "herdr:antigravity_cli"
max_reply_bytes = 64 * 1024
tail_chunk_bytes = 64 * 1024
action = sys.argv[1]

try:
    payload = json.load(sys.stdin)
except Exception:
    raise SystemExit(0)

if not isinstance(payload, dict):
    raise SystemExit(0)

def text(name):
    value = payload.get(name)
    return value if isinstance(value, str) and value else None

def first_record(path):
    with open(path, "rb") as transcript:
        return json.loads(transcript.readline())

def last_record(path):
    # Transcripts grow with the conversation, so read backwards from the end
    # only until the last line is complete.
    with open(path, "rb") as transcript:
        position = transcript.seek(0, os.SEEK_END)
        tail = b""
        while position > 0:
            size = min(tail_chunk_bytes, position)
            position -= size
            transcript.seek(position)
            tail = transcript.read(size) + tail
            lines = tail.rstrip(b"\n")
            line_start = lines.rfind(b"\n")
            if line_start >= 0:
                return json.loads(lines[line_start + 1:])
        return json.loads(tail)

def is_main_conversation(path):
    try:
        record = first_record(path)
    except Exception:
        return False
    return isinstance(record, dict) and record.get("type") == "USER_INPUT"

def final_reply(path):
    output = text("finalModelOutput")
    if output is not None:
        return output
    # At Stop, the last transcript record of a normally finished turn is the
    # model response that ended it: text and no tool calls.
    try:
        record = last_record(path)
    except Exception:
        return None
    if not isinstance(record, dict):
        return None
    content = record.get("content")
    if (
        record.get("type") == "PLANNER_RESPONSE"
        and record.get("source") == "MODEL"
        and not record.get("tool_calls")
        and isinstance(content, str)
        and content
    ):
        return content
    return None

def send(method, params, timeout):
    request = {
        "id": source + ":" + str(params["seq"]),
        "method": method,
        "params": params,
    }
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(timeout)
            client.connect(os.environ["HERDR_SOCKET_PATH"])
            client.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
            client.recv(4096)
    except Exception:
        pass

session_id = text("conversationId")
transcript_path = text("transcriptPath")
if session_id is None or transcript_path is None:
    raise SystemExit(0)
if not is_main_conversation(transcript_path):
    raise SystemExit(0)

# Reporting the conversation on Stop too guarantees Herdr has it by the end of
# the first turn, before the reply that must match it.
seq = time.time_ns()
send(
    "pane.report_agent_session",
    {
        "pane_id": os.environ["HERDR_PANE_ID"],
        "source": source,
        "agent": "agy",
        "seq": seq,
        "agent_session_id": session_id,
        "agent_session_path": transcript_path,
    },
    0.5,
)

# Errors and other early stops have no final reply. Declined or interrupted
# turns fire no Stop at all.
if action != "reply" or payload.get("terminationReason") != "NO_TOOL_CALL":
    raise SystemExit(0)

reply = final_reply(transcript_path)
if reply is None:
    raise SystemExit(0)

encoded = reply.encode("utf-8", errors="replace")
params = {
    "pane_id": os.environ["HERDR_PANE_ID"],
    "source": source,
    "agent": "agy",
    "seq": seq + 1,
    "agent_session_id": session_id,
    "text": encoded[:max_reply_bytes].decode("utf-8", errors="ignore"),
}
if len(encoded) > max_reply_bytes:
    params["truncated"] = True
send("pane.report_agent_reply", params, 2.0)
' "$1" 2>/dev/null || true

emit_and_exit
