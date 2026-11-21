"""Slow SSE mock upstream used to verify real-time delta relay.

Start it, then run the sidecar with:

    MOONLIGHT_UPSTREAM=http://127.0.0.1:9101/v1 \
    MOONLIGHT_UPSTREAM_KEY=sk-test MOONLIGHT_MODEL=test-model \
    moonlight-core --root <library>

and call `explain` with a `request_id`. Every delta should show up on stdout as
an `ai_delta` event ~1.2s apart instead of arriving together at the end.
"""
import json
import sys
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

PIECES = ["第一段", "第二段", "第三段"]
DELAY_SECONDS = 1.2


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_POST(self):  # noqa: N802 - http.server API
        length = int(self.headers.get("content-length", 0))
        self.rfile.read(length)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        for piece in PIECES:
            payload = json.dumps({"choices": [{"delta": {"content": piece}}]}, ensure_ascii=False)
            frame = f"data: {payload}\n\n".encode()
            self.wfile.write(b"%x\r\n%s\r\n" % (len(frame), frame))
            self.wfile.flush()
            time.sleep(DELAY_SECONDS)
        done = b"data: [DONE]\n\n"
        self.wfile.write(b"%x\r\n%s\r\n" % (len(done), done))
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()

    def log_message(self, *_args):
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 9101
    HTTPServer(("127.0.0.1", port), Handler).serve_forever()
