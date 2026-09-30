#!/bin/sh
# installed by herdr
# managed by herdr; reinstalling or updating the integration overwrites this file.
# add custom hooks beside this file instead of editing it.
# HERDR_INTEGRATION_ID=claude
# HERDR_INTEGRATION_VERSION=11

set -eu

action="${1:-}"
hook_input_file="$(mktemp "${TMPDIR:-/tmp}/herdr-claude-hook.XXXXXX")" || exit 0
trap 'rm -f "$hook_input_file"' EXIT HUP INT TERM
cat >"$hook_input_file" 2>/dev/null || true

case "$action" in
  session|reply) ;;
  permission)
    # Only panes whose clients answer permission requests wait on Herdr.
    [ -n "${HERDR_REMOTE_ANSWERS:-}" ] || exit 0
    ;;
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

source = "herdr:claude"
max_reply_bytes = 64 * 1024
max_preview_bytes = 8 * 1024
# Herdr ends an unanswered request after this wait; the socket waits a little
# longer so that Herdr's response, not the socket, ends the wait.
permission_timeout_ms = 24 * 60 * 60 * 1000
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


def question_params(tool_input):
    """Maps AskUserQuestion input to Herdr questions, or None when it is malformed."""
    questions = tool_input.get("questions") if isinstance(tool_input, dict) else None
    if not isinstance(questions, list) or not questions:
        return None
    mapped = []
    for item in questions:
        text = item.get("question") if isinstance(item, dict) else None
        if not isinstance(text, str) or not text:
            return None
        question = {"question": text}
        header = item.get("header")
        if isinstance(header, str) and header:
            question["header"] = header
        options = []
        raw_options = item.get("options")
        for option in raw_options if isinstance(raw_options, list) else []:
            label = option.get("label") if isinstance(option, dict) else None
            if not isinstance(label, str) or not label:
                continue
            entry = {"label": label}
            description = option.get("description")
            if isinstance(description, str) and description:
                entry["description"] = description
            options.append(entry)
        if options:
            question["options"] = options
        question["multi_select"] = item.get("multiSelect") is True
        mapped.append(question)
    return mapped


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


def permission_decision(result, suggestions):
    decision = result.get("decision")
    if decision == "allow":
        return {"behavior": "allow"}
    if decision == "allow_always":
        return {"behavior": "allow", "updatedPermissions": suggestions}
    if decision == "deny":
        message = result.get("message")
        if not isinstance(message, str) or not message:
            message = default_deny_message
        # Interrupt the turn like choosing No in Claude Code's own prompt.
        return {"behavior": "deny", "message": message, "interrupt": True}
    return None


def question_decision(result, tool_input):
    answers = result.get("answers")
    if not isinstance(answers, dict):
        return None
    joined = {}
    for question, values in answers.items():
        if not isinstance(values, list) or not all(isinstance(value, str) for value in values):
            return None
        joined[question] = ", ".join(values)
    updated_input = dict(tool_input)
    updated_input["answers"] = joined
    return {"behavior": "allow", "updatedInput": updated_input}


def report_permission_request(params):
    """Reports the request, waits for its answer, and prints Claude's decision.

    Printing nothing leaves the decision to Claude Code's own prompt."""
    tool_name = hook_input.get("tool_name")
    # Claude Code's plan approval stays in the terminal.
    if not isinstance(tool_name, str) or not tool_name or tool_name == "ExitPlanMode":
        return
    tool_input = hook_input.get("tool_input")
    if tool_input is None:
        tool_input = {}
    suggestions = hook_input.get("permission_suggestions")
    if tool_name == "AskUserQuestion":
        questions = question_params(tool_input)
        if not questions:
            return
        params["kind"] = "question"
        params["questions"] = questions
    else:
        params["kind"] = "permission"
        decisions = ["allow"]
        if isinstance(suggestions, list) and suggestions:
            decisions.append("allow_always")
        decisions.append("deny")
        params["decisions"] = decisions
    params["tool_name"] = tool_name
    description = tool_input.get("description") if isinstance(tool_input, dict) else None
    if isinstance(description, str) and description:
        params["description"] = description
    params["input_preview"] = input_preview(tool_input)
    params["timeout_ms"] = permission_timeout_ms
    request = {
        "id": request_id,
        "method": "pane.report_agent_request",
        "params": params,
    }
    result = wait_for_answer(request, permission_socket_timeout)
    if result is None:
        return
    if params["kind"] == "question":
        decision = question_decision(result, tool_input)
    else:
        decision = permission_decision(result, suggestions)
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


if "CURSOR_VERSION" in os.environ or "cursor_version" in hook_input:
    raise SystemExit(0)
hook_event_name = str(hook_input.get("hook_event_name") or "")
expected_event_names = {"reply": "Stop", "permission": "PermissionRequest"}
if hook_event_name != expected_event_names.get(action, "SessionStart"):
    raise SystemExit(0)
# A subagent's permission request blocks the turn like the parent's own, so it
# is reported; other subagent events are not.
is_subagent = bool(hook_input.get("agent_id"))
if is_subagent and action != "permission":
    raise SystemExit(0)
# Grok imports Claude hooks and sets GROK_SESSION_ID in every hook process.
if action in ("reply", "permission") and "GROK_SESSION_ID" in os.environ:
    raise SystemExit(0)
request_id = f"{source}:{int(time.time() * 1000)}:{random.randrange(1_000_000):06d}"
report_seq = time.time_ns()
session_id = hook_input.get("session_id")
agent_session_id = session_id if isinstance(session_id, str) and session_id else None
socket_timeout = 0.5
if action == "permission":
    params = {
        "pane_id": pane_id,
        "source": source,
        "agent": "claude",
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
        "agent": "claude",
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
    agent_session_path = transcript_path if isinstance(transcript_path, str) and transcript_path else None
    session_start_source = hook_input.get("source")
    if not isinstance(session_start_source, str) or not session_start_source:
        session_start_source = None
    params = {
        "pane_id": pane_id,
        "source": source,
        "agent": "claude",
        "seq": report_seq,
        "agent_session_id": agent_session_id,
    }
    if agent_session_path:
        params["agent_session_path"] = agent_session_path
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
