"""A sleeping Mac running lidwake, for MacWakeTests.swift.

The HTTP side stays down until a valid magic packet for MAC arrives on UDP, then comes up after
WAKE_DELAY seconds, like a Mac waking from DarkWake. Same protocol as lidwake: GET /challenge
issues a single-use nonce; /hold, /release and /status need sig = sha256("<token>:<action>:<nonce>").

Usage: mock_lidwake.py HTTP_PORT UDP_PORT MAC TOKEN
"""
import hashlib
import json
import secrets
import socket
import sys
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WAKE_DELAY = 3.0

http_port, udp_port, mac, token = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3], sys.argv[4]
expected_packet = b"\xff" * 6 + bytes.fromhex(mac.replace(":", "")) * 16
nonces: set[str] = set()
held = {"phoneHold": False}


class Handler(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        url = urllib.parse.urlparse(self.path)
        action = url.path.strip("/")
        query = dict(urllib.parse.parse_qsl(url.query))
        if action == "challenge":
            nonce = secrets.token_hex(16)
            nonces.add(nonce)
            return self.reply(200, {"ok": True, "nonce": nonce})
        nonce = query.get("nonce", "")
        if nonce not in nonces:
            return self.reply(403, {"ok": False, "error": "unknown or expired nonce"})
        nonces.discard(nonce)
        if hashlib.sha256(f"{token}:{action}:{nonce}".encode()).hexdigest() != query.get("sig"):
            return self.reply(403, {"ok": False, "error": "bad signature"})
        if action == "hold":
            held["phoneHold"] = True
        elif action == "release":
            held["phoneHold"] = False
        phone_hold = held["phoneHold"]
        self.reply(200, {"ok": True, "held": phone_hold, "phoneHold": phone_hold,
                         "holdUntil": "23:59" if phone_hold else None, "agentsRunning": False,
                         "onBattery": True, "battery": 42})

    def reply(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *_args):
        pass


udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
udp.bind(("127.0.0.1", udp_port))
print("asleep", flush=True)
while True:
    packet, _ = udp.recvfrom(2048)
    if packet == expected_packet:
        break
    print(f"ignored a {len(packet)}-byte packet", flush=True)
print("magic packet received", flush=True)
time.sleep(WAKE_DELAY)
print("awake", flush=True)
ThreadingHTTPServer(("127.0.0.1", http_port), Handler).serve_forever()
