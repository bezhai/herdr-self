#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=codex
# HERDR_INTEGRATION_VERSION=9

set -eu

action="${1:-}"
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/herdr-codex-hook.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

# Herdr decides whether a permission request waits: it ends the report at once
# unless a client turned remote answers on for the pane's agent, since Codex
# shows no approval prompt of its own while the hook waits.
case "$action" in
  session|reply|permission) ;;
  *) exit 0 ;;
esac

[ "${HERDR_ENV:-}" = "1" ] || exit 0
[ -n "${HERDR_SOCKET_PATH:-}" ] || exit 0
[ -n "${HERDR_PANE_ID:-}" ] || exit 0
command -v python3 >/dev/null 2>&1 || exit 0

# python3 replaces the shell, so killing the hook closes its Herdr connection
# and withdraws a waiting permission request. The EXIT trap does not run after
# exec; python3 removes the input file itself.
HERDR_ACTION="$action" HERDR_HOOK_INPUT_FILE="$hook_input_file" exec python3 - <<'PY'
import json
import os
import random
import socket
import sys
import time

source = "herdr:codex"
max_reply_bytes = 64 * 1024
max_preview_bytes = 8 * 1024
# After this wait Herdr ends the request and Codex shows its own approval
# prompt. The socket waits a little longer so that Herdr's response, not the
# socket, ends the wait.
permission_timeout_ms = 10 * 60 * 1000
permission_socket_timeout = permission_timeout_ms / 1000 + 30
default_deny_message = "The user denied this permission request."
action = os.environ.get("HERDR_ACTION", "")
pane_id = os.environ.get("HERDR_PANE_ID")
socket_path = os.environ.get("HERDR_SOCKET_PATH")
hook_input_file = os.environ.get("HERDR_HOOK_INPUT_FILE")

hook_input = {}
if hook_input_file:
    try:
        with open(hook_input_file, encoding="utf-8") as handle:
            content = handle.read()
        if content.strip():
            hook_input = json.loads(content)
    except Exception:
        hook_input = {}
    try:
        os.unlink(hook_input_file)
    except OSError:
        pass
if not isinstance(hook_input, dict):
    hook_input = {}

if not pane_id or not socket_path:
    raise SystemExit(0)


def utf8_prefix(text, max_bytes):
    encoded = text.encode("utf-8", errors="replace")
    return encoded[:max_bytes].decode("utf-8", errors="ignore")


def input_preview(tool_input):
    command = tool_input.get("command") if isinstance(tool_input, dict) else None
    if isinstance(command, str):
        return utf8_prefix(command, max_preview_bytes)
    return utf8_prefix(json.dumps(tool_input, ensure_ascii=False, indent=2), max_preview_bytes)


def wait_for_answer(request, timeout):
    """Sends one request line and returns the answered result, or None."""
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(timeout)
        client.connect(socket_path)
        # Herdr withdraws the request when the connection ends or carries more
        # bytes, so the hook neither shuts down its side nor writes again.
        client.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
        response = b""
        while b"\n" not in response:
            chunk = client.recv(65536)
            if not chunk:
                break
            response += chunk
        client.close()
        result = json.loads(response.split(b"\n", 1)[0].decode("utf-8")).get("result")
    except Exception:
        return None
    if isinstance(result, dict) and result.get("type") == "agent_request_answered":
        return result
    return None


def permission_decision(result):
    decision = result.get("decision")
    if decision == "allow":
        return {"behavior": "allow"}
    if decision == "deny":
        message = result.get("message")
        if not isinstance(message, str) or not message:
            message = default_deny_message
        return {"behavior": "deny", "message": message}
    return None


def report_permission_request(params):
    """Reports the request, waits for its answer, and prints Codex's decision.

    Printing nothing lets Codex show its own approval prompt."""
    tool_name = hook_input.get("tool_name")
    if not isinstance(tool_name, str) or not tool_name:
        return
    tool_input = hook_input.get("tool_input")
    if tool_input is None:
        tool_input = {}
    params["kind"] = "permission"
    params["tool_name"] = tool_name
    description = tool_input.get("description") if isinstance(tool_input, dict) else None
    if isinstance(description, str) and description:
        params["description"] = description
    params["input_preview"] = input_preview(tool_input)
    # Codex hooks can only allow once or deny.
    params["decisions"] = ["allow", "deny"]
    params["timeout_ms"] = permission_timeout_ms
    request = {
        "id": request_id,
        "method": "pane.report_agent_request",
        "params": params,
    }
    result = wait_for_answer(request, permission_socket_timeout)
    decision = permission_decision(result) if result is not None else None
    if decision is None:
        return
    output = {
        "hookSpecificOutput": {
            "hookEventName": "PermissionRequest",
            "decision": decision,
        },
    }
    sys.stdout.buffer.write((json.dumps(output, ensure_ascii=False) + "\n").encode("utf-8"))
    sys.stdout.flush()


hook_event_name = str(hook_input.get("hook_event_name") or "")
if action == "reply":
    if hook_event_name != "Stop":
        raise SystemExit(0)
elif action == "permission":
    if hook_event_name != "PermissionRequest":
        raise SystemExit(0)
elif hook_event_name and hook_event_name != "SessionStart":
    raise SystemExit(0)

request_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
report_seq = time.time_ns()
session_id = hook_input.get("session_id")
agent_session_id = session_id if isinstance(session_id, str) and session_id else None
inherited_session_id = os.environ.get("CODEX_THREAD_ID")
if inherited_session_id and inherited_session_id != agent_session_id:
    raise SystemExit(0)
socket_timeout = 0.5
if action == "permission":
    params = {
        "pane_id": pane_id,
        "source": source,
        "agent": "codex",
    }
    if agent_session_id:
        params["agent_session_id"] = agent_session_id
    try:
        report_permission_request(params)
    except Exception:
        pass
    raise SystemExit(0)
elif action == "reply":
    message = hook_input.get("last_assistant_message")
    if not isinstance(message, str) or not message:
        raise SystemExit(0)
    encoded = message.encode("utf-8", errors="replace")
    truncated = len(encoded) > max_reply_bytes
    text = encoded[:max_reply_bytes].decode("utf-8", errors="ignore")
    params = {
        "pane_id": pane_id,
        "source": source,
        "agent": "codex",
        "seq": report_seq,
    }
    if agent_session_id:
        params["agent_session_id"] = agent_session_id
    params["text"] = text
    if truncated:
        params["truncated"] = True
    request = {
        "id": request_id,
        "method": "pane.report_agent_reply",
        "params": params,
    }
    socket_timeout = 2.0
elif agent_session_id:
    transcript_path = hook_input.get("transcript_path")
    if not isinstance(transcript_path, str) or not transcript_path.strip():
        raise SystemExit(0)
    session_start_source = hook_input.get("source") if hook_event_name == "SessionStart" else None
    if not isinstance(session_start_source, str) or not session_start_source:
        session_start_source = None
    params = {
        "pane_id": pane_id,
        "source": source,
        "agent": "codex",
        "seq": report_seq,
        "agent_session_id": agent_session_id,
    }
    if session_start_source:
        params["session_start_source"] = session_start_source
    request = {
        "id": request_id,
        "method": "pane.report_agent_session",
        "params": params,
    }
else:
    raise SystemExit(0)

try:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(socket_timeout)
    client.connect(socket_path)
    client.sendall((json.dumps(request, ensure_ascii=False) + "\n").encode("utf-8"))
    try:
        client.recv(4096)
    except Exception:
        pass
    client.close()
except Exception:
    pass
PY
