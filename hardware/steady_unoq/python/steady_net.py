"""Just enough WebSocket server for the Steady UNO Q app.

The Linux side of the UNO Q has no guaranteed pip packages, so this speaks RFC
6455 with the standard library only: it accepts upgrades, reads client text
frames and ping frames, and broadcasts text frames to every connected browser.

One instance per app. Browsers connect from the Settings page in the dashboard
(`src/hardware/connection.ts`, transport `network`).
"""

from __future__ import annotations

import base64
import hashlib
import socket
import struct
import threading

_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# A dashboard sends only tiny commands; anything bigger is a broken client.
_MAX_FRAME = 8192

_OP_TEXT = 0x1
_OP_CLOSE = 0x8
_OP_PING = 0x9
_OP_PONG = 0xA


def _recv_exact(conn: socket.socket, size: int) -> bytes:
    """Read exactly `size` bytes, or return b"" if the peer went away."""
    chunks: list[bytes] = []
    remaining = size
    while remaining > 0:
        chunk = conn.recv(min(remaining, 4096))
        if not chunk:
            return b""
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _handshake(conn: socket.socket) -> bool:
    request = b""
    while b"\r\n\r\n" not in request:
        chunk = conn.recv(1024)
        if not chunk:
            return False
        request += chunk
        if len(request) > 8192:
            return False

    key = ""
    for line in request.decode("latin-1").split("\r\n"):
        name, _, value = line.partition(":")
        if name.strip().lower() == "sec-websocket-key":
            key = value.strip()
            break
    if not key:
        conn.sendall(b"HTTP/1.1 400 Bad Request\r\n\r\n")
        return False

    accept = base64.b64encode(hashlib.sha1((key + _GUID).encode()).digest()).decode()
    conn.sendall(
        (
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
        ).encode()
    )
    return True


def _read_frame(conn: socket.socket) -> tuple[int, bytes] | tuple[None, bytes]:
    head = _recv_exact(conn, 2)
    if len(head) < 2:
        return None, b""

    opcode = head[0] & 0x0F
    masked = bool(head[1] & 0x80)
    length = head[1] & 0x7F

    if length == 126:
        raw = _recv_exact(conn, 2)
        if len(raw) < 2:
            return None, b""
        length = struct.unpack("!H", raw)[0]
    elif length == 127:
        raw = _recv_exact(conn, 8)
        if len(raw) < 8:
            return None, b""
        length = struct.unpack("!Q", raw)[0]

    if length > _MAX_FRAME:
        raise ValueError(f"frame too large: {length} bytes")

    mask = _recv_exact(conn, 4) if masked else b""
    if masked and len(mask) < 4:
        return None, b""

    payload = _recv_exact(conn, length) if length else b""
    if length and len(payload) < length:
        return None, b""

    if mask:
        payload = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))

    return opcode, payload


def _frame(payload: bytes, opcode: int = _OP_TEXT) -> bytes:
    """Server frames are never masked."""
    length = len(payload)
    if length < 126:
        header = struct.pack("!BB", 0x80 | opcode, length)
    elif length < 65536:
        header = struct.pack("!BBH", 0x80 | opcode, 126, length)
    else:
        header = struct.pack("!BBQ", 0x80 | opcode, 127, length)
    return header + payload


class WebSocketServer:
    """Accepts browser connections and broadcasts text to all of them."""

    def __init__(
        self,
        host: str = "0.0.0.0",
        port: int = 8765,
        on_message=None,
        on_connect=None,
        on_disconnect=None,
    ):
        self.host = host
        self.port = port
        self.on_message = on_message
        self.on_connect = on_connect
        self.on_disconnect = on_disconnect

        self._clients: dict[int, socket.socket] = {}
        self._lock = threading.Lock()
        self._next_id = 0
        self._running = True

        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self._socket.bind((host, port))
        self._socket.listen(8)
        self._socket.settimeout(0.5)

        self._thread = threading.Thread(target=self._accept_loop, name="steady-ws", daemon=True)

    # ----- lifecycle -----

    def start(self) -> "WebSocketServer":
        self._thread.start()
        return self

    def close(self) -> None:
        self._running = False
        try:
            self._socket.close()
        except OSError:
            pass
        with self._lock:
            clients, self._clients = list(self._clients.values()), {}
        for conn in clients:
            try:
                conn.close()
            except OSError:
                pass

    @property
    def client_count(self) -> int:
        with self._lock:
            return len(self._clients)

    # ----- sending -----

    def broadcast(self, text: str) -> None:
        if not text:
            return
        frame = _frame(text.encode("utf-8"))
        dead: list[int] = []
        with self._lock:
            for client_id, conn in self._clients.items():
                try:
                    conn.sendall(frame)
                except OSError:
                    dead.append(client_id)
        for client_id in dead:
            self._drop(client_id)

    def _drop(self, client_id: int) -> None:
        with self._lock:
            conn = self._clients.pop(client_id, None)
        if conn is not None:
            try:
                conn.close()
            except OSError:
                pass

    def _accept_loop(self) -> None:
        while self._running:
            try:
                conn, _address = self._socket.accept()
            except socket.timeout:
                continue
            except OSError:
                break
            threading.Thread(target=self._serve, args=(conn,), name="steady-ws-client", daemon=True).start()

    def _serve(self, conn: socket.socket) -> None:
        try:
            conn.settimeout(None)
            if not _handshake(conn):
                conn.close()
                return
        except OSError:
            return

        with self._lock:
            client_id = self._next_id
            self._next_id += 1
            self._clients[client_id] = conn

        if self.on_connect is not None:
            try:
                self.on_connect(lambda text: conn.sendall(_frame(text.encode("utf-8"))))
            except OSError:
                pass

        try:
            while self._running:
                opcode, payload = _read_frame(conn)
                if opcode is None or opcode == _OP_CLOSE:
                    break
                if opcode == _OP_PING:
                    try:
                        conn.sendall(_frame(payload, _OP_PONG))
                    except OSError:
                        break
                    continue
                if opcode == _OP_TEXT and self.on_message is not None:
                    try:
                        self.on_message(payload.decode("utf-8"))
                    except Exception:  # a bad frame must not kill the connection
                        pass
        except (OSError, ValueError):
            pass
        finally:
            self._drop(client_id)
            if self.on_disconnect is not None:
                try:
                    self.on_disconnect()
                except Exception:
                    pass
