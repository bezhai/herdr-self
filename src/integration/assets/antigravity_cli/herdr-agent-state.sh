#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=antigravity_cli
# HERDR_INTEGRATION_VERSION=4

# `session` runs on PreInvocation and reports the Antigravity conversation so
# Herdr can resume the pane. `reply` runs on Stop and reports the conversation
# again, then the turn's final reply. `tool-start` and `tool-end` run on
# PreToolUse and PostToolUse and report the start or end of a tool call, keyed
# by its step index; the payloads do not name their event, so the action does.
# Lifecycle state comes from Herdr's screen detection.
#
# Subagents run inside the same Antigravity process and fire the same hooks
# with their own conversation. Every action therefore reports only the main
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
  session|reply|tool-start|tool-end) ;;
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
max_title_chars = 120
tool_phases = {"tool-start": "start", "tool-end": "end"}
# A tool title is the first of these arguments the call has.
title_args = ("toolSummary", "CommandLine", "TargetFile", "File", "AbsolutePath", "Url", "Query")
path_args = {"TargetFile", "File", "AbsolutePath"}
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

def one_line(value):
    if not isinstance(value, str):
        return None
    text = " ".join(value.split())
    if len(text) > max_title_chars:
        text = text[: max_title_chars - 1].rstrip() + "\u2026"
    return text or None

def display_path(path, args):
    # Paths inside the working directory are shown relative to it.
    cwd = args.get("Cwd")
    if not isinstance(cwd, str) or not cwd:
        workspaces = payload.get("workspacePaths")
        cwd = workspaces[0] if isinstance(workspaces, list) and workspaces else None
    root = cwd.rstrip("/") if isinstance(cwd, str) else ""
    if root and path.startswith(root + "/"):
        return path[len(root) + 1:]
    return path

def tool_call_params(session_id):
    tool_call = payload.get("toolCall")
    tool_call = tool_call if isinstance(tool_call, dict) else {}
    name = tool_call.get("name")
    # protojson writes 64-bit integers as strings.
    step = payload.get("stepIdx")
    if isinstance(step, bool) or not isinstance(step, (int, str)) or not str(step).isdigit():
        return None
    if not isinstance(name, str) or not name:
        return None
    params = {
        "pane_id": os.environ["HERDR_PANE_ID"],
        "source": source,
        "agent": "agy",
        "agent_session_id": session_id,
        "tool_call_id": str(step),
        "phase": tool_phases[action],
        "tool_name": name,
    }
    args = tool_call.get("args")
    args = args if isinstance(args, dict) else {}
    for arg in title_args:
        value = args.get(arg)
        if isinstance(value, str) and value.strip():
            params["title"] = one_line(display_path(value, args) if arg in path_args else value)
            break
    error = payload.get("error")
    if action == "tool-end" and isinstance(error, str) and error:
        params["failed"] = True
    return params

def send(method, params, timeout):
    request = {
        "id": source + ":" + str(time.time_ns()),
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

if action in tool_phases:
    params = tool_call_params(session_id)
    if params is not None:
        send("pane.report_agent_tool_call", params, 0.5)
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
