"""OpenAI-compatible stub model server with scripted behaviour (ADAPTERS 7).

The scenario is the part of the model slug after the first slash: slug "stub/stall_on_3" runs
the `stall_on_3` scenario. Serves POST .../chat/completions as SSE when the request sets
`stream` (Hermes streams by default) and as one JSON body otherwise (the minimal loop, P2).

The step number of a main-loop call is the count of assistant messages already in the
request, so auxiliary calls and retries do not shift a script.

Scenarios
  plain               one answer: "FINAL: 8081"
  echo_memory         answers with the staging DB from the system prompt when memory is in it,
                      "FINAL: unknown" when it is not (a stand-in for a memory-dependent task)
  shell_then_answer   step 0 calls the shell tool, then answers "FINAL: 8081"
  all_tools           step 0 calls every tool it is offered, then answers
  malformed_tool      every step calls a tool with unparseable JSON arguments
  rate_limit_twice    HTTP 429 on the first 2 requests, then "plain"
  always_429          HTTP 429 on every request
  server_error        HTTP 500 on every request
  stall_on_3          steps 0 and 1 call the shell tool, step 2 never answers
  loop_tools          every step calls the shell tool (drives the max_steps cap)
  padded              one answer with leading and trailing whitespace (H-11: kept verbatim)
  risky_command       step 0 runs a recursive delete in the workspace, then answers (A-12: no prompt)
"""
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any

ANSWER = "FINAL: 8081"
STAGING_DB = "pg-stage-07.internal:6432"


def _scenario(model: str) -> str:
    return model.split("/", 1)[1] if "/" in model else model


def _find_tool(tools: list[dict[str, Any]], *needles: str) -> dict[str, Any] | None:
    for needle in needles:
        for t in tools:
            if needle in t.get("function", {}).get("name", ""):
                return t["function"]
    return tools[0]["function"] if tools else None


def _args_for(fn: dict[str, Any], command: str = "echo hi") -> dict[str, Any]:
    """Minimal arguments satisfying the tool's schema (strings get `command` for the first one)."""
    params = fn.get("parameters", {})
    props = params.get("properties", {})
    out: dict[str, Any] = {}
    first_string = True
    for name in params.get("required", list(props)[:1]):
        kind = props.get(name, {}).get("type", "string")
        if kind == "string":
            out[name] = command if first_string else "x"
            first_string = False
        elif kind == "integer" or kind == "number":
            out[name] = 1
        elif kind == "boolean":
            out[name] = False
        elif kind == "array":
            out[name] = []
        else:
            out[name] = {}
    return out


def _tool_call(index: int, name: str, arguments: str) -> dict[str, Any]:
    return {"id": f"call_{index}_{name}"[:40], "type": "function", "function": {"name": name, "arguments": arguments}}


class StubState:
    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.lock = threading.Lock()
        self.stop = threading.Event()


def _plan(scenario: str, body: dict[str, Any], n_request: int) -> dict[str, Any]:
    """Returns {"http": status} | {"stall": True} | {"content": str, "tool_calls": [..]}."""
    messages = body.get("messages", [])
    tools = body.get("tools") or []
    step = sum(1 for m in messages if m.get("role") == "assistant")
    system = " ".join(str(m.get("content")) for m in messages if m.get("role") == "system")

    if scenario == "always_429":
        return {"http": 429}
    if scenario == "server_error":
        return {"http": 500}
    if scenario == "rate_limit_twice" and n_request < 2:
        return {"http": 429}
    if scenario == "padded":
        return {"content": "  Done.\nFINAL: 8081  \n\n", "tool_calls": []}
    if scenario == "risky_command":
        shell = _find_tool(tools, "terminal", "shell", "bash")
        if shell is not None and step < 1:
            cmd = "mkdir -p zz_scratch && rm -rf zz_scratch && echo risky-done"
            return {"content": "", "tool_calls": [_tool_call(0, shell["name"], json.dumps(_args_for(shell, cmd)))]}
        return {"content": ANSWER, "tool_calls": []}
    if scenario == "echo_memory":
        return {"content": f"FINAL: {_staging_db(system)}", "tool_calls": []}
    if scenario in ("shell_then_answer", "stall_on_3", "loop_tools"):
        shell = _find_tool(tools, "terminal", "shell", "bash")
        if scenario == "stall_on_3" and step >= 2:
            return {"stall": True}
        if shell is not None and (scenario == "loop_tools" or step < (2 if scenario == "stall_on_3" else 1)):
            return {"content": "", "tool_calls": [_tool_call(0, shell["name"], json.dumps(_args_for(shell, f"echo step{step}")))]}
        return {"content": ANSWER, "tool_calls": []}
    if scenario == "all_tools":
        if step == 0 and tools:
            calls = [_tool_call(i, t["function"]["name"], json.dumps(_args_for(t["function"]))) for i, t in enumerate(tools)]
            return {"content": "", "tool_calls": calls}
        return {"content": "FINAL: done", "tool_calls": []}
    if scenario == "malformed_tool":
        fn = _find_tool(tools, "terminal", "shell", "read_file")
        if fn is not None:
            return {"content": "", "tool_calls": [_tool_call(0, fn["name"], "{not valid json")]}
    return {"content": ANSWER, "tool_calls": []}


_DB_PROSE = re.compile(r"host\s+([\w.-]+),?\s+port\s+(\d+)")


def _staging_db(system: str) -> str:
    """What a model that read the memory would answer: host:port from the staging-database entry,
    in the fixture's own wording or as a literal host:port. 'unknown' when memory is absent."""
    if STAGING_DB in system:
        return STAGING_DB
    m = _DB_PROSE.search(system)
    return f"{m.group(1)}:{m.group(2)}" if m else "unknown"


def _usage(body: dict[str, Any], content: str) -> dict[str, int]:
    prompt = max(1, len(json.dumps(body.get("messages", []))) // 4)
    completion = max(1, len(content) // 4 + 1)
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": prompt + completion}


def _make_handler(state: StubState):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *args: Any) -> None:
            pass

        def _json(self, status: int, payload: dict[str, Any], extra: dict[str, str] | None = None) -> None:
            raw = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(raw)

        def do_GET(self) -> None:  # noqa: N802
            self._json(200, {"status": "ok"})

        def do_POST(self) -> None:  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = json.loads(self.rfile.read(length) or b"{}")
            with state.lock:
                # Counted per model slug so each scenario run starts its script from 0.
                n_request = sum(1 for r in state.requests if r["body"].get("model") == body.get("model"))
                state.requests.append({"path": self.path, "headers": dict(self.headers), "body": body})
            if not self.path.rstrip("/").endswith("/chat/completions"):
                self._json(404, {"error": {"message": "not found"}})
                return
            plan = _plan(_scenario(str(body.get("model", ""))), body, n_request)
            if "http" in plan:
                self._json(
                    plan["http"],
                    {"error": {"message": f"stub http {plan['http']}", "type": "stub_error", "code": plan["http"]}},
                    {"Retry-After": "0"},
                )
                return
            if plan.get("stall"):
                state.stop.wait(timeout=3600)
                return
            self._answer(body, plan)

        def _answer(self, body: dict[str, Any], plan: dict[str, Any]) -> None:
            content: str = plan["content"]
            tool_calls: list[dict[str, Any]] = plan["tool_calls"]
            finish = "tool_calls" if tool_calls else "stop"
            usage = _usage(body, content + json.dumps(tool_calls))
            base = {"id": "chatcmpl-stub", "created": int(time.time()), "model": body.get("model", "stub")}
            if not body.get("stream"):
                message: dict[str, Any] = {"role": "assistant", "content": content or None}
                if tool_calls:
                    message["tool_calls"] = tool_calls
                self._json(200, {**base, "object": "chat.completion", "choices": [{"index": 0, "message": message, "finish_reason": finish}], "usage": usage})
                return

            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def send(obj: dict[str, Any] | str) -> None:
                data = ("data: " + (obj if isinstance(obj, str) else json.dumps(obj)) + "\n\n").encode()
                self.wfile.write(f"{len(data):x}\r\n".encode() + data + b"\r\n")
                self.wfile.flush()

            chunk = {**base, "object": "chat.completion.chunk"}
            send({**chunk, "choices": [{"index": 0, "delta": {"role": "assistant", "content": ""}, "finish_reason": None}]})
            if content:
                send({**chunk, "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": None}]})
            for i, tc in enumerate(tool_calls):
                send({**chunk, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": i, **tc}]}, "finish_reason": None}]})
            send({**chunk, "choices": [{"index": 0, "delta": {}, "finish_reason": finish}]})
            if (body.get("stream_options") or {}).get("include_usage"):
                send({**chunk, "choices": [], "usage": usage})
            send("[DONE]")
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()

    return Handler


class _QuietServer(ThreadingHTTPServer):
    def handle_error(self, request: Any, client_address: Any) -> None:
        pass  # clients that hang up mid-request (a killed child) are expected, not errors


class StubServer:
    """Runs in a thread; reachable from child processes on 127.0.0.1."""

    def __init__(self) -> None:
        self.state = StubState()
        self._httpd = _QuietServer(("127.0.0.1", 0), _make_handler(self.state))
        self._httpd.daemon_threads = True
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}/v1"

    @property
    def requests(self) -> list[dict[str, Any]]:
        with self.state.lock:
            return list(self.state.requests)

    def start(self) -> "StubServer":
        self._thread.start()
        return self

    def stop(self) -> None:
        self.state.stop.set()
        self._httpd.shutdown()
        self._httpd.server_close()


if __name__ == "__main__":
    s = StubServer().start()
    print(s.base_url, flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        s.stop()
