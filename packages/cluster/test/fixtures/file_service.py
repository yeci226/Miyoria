"""A file service for the relay tests: serves `<dir>/<name>` at `/files/<name>` the way the song
worker serves a song's files (Starlette's `FileResponse` under uvicorn), on a free loopback port.

    python file_service.py <dir> <port>

Prints `port <n>` once it listens; stops when its stdin closes.
"""

import asyncio
import socket
import sys
import threading
from pathlib import Path

import uvicorn
from starlette.applications import Starlette
from starlette.responses import FileResponse, PlainTextResponse
from starlette.routing import Route

ROOT = Path(sys.argv[1])


async def get_file(request):
    p = ROOT / request.path_params["name"]
    if not p.is_file():
        return PlainTextResponse("no such file", status_code=404)
    return FileResponse(p, media_type="audio/L16; rate=48000; channels=1")


app = Starlette(routes=[Route("/files/{name}", get_file)])


def main() -> None:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", int(sys.argv[2])))
    sock.listen(64)
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning"))

    def watch_stdin() -> None:
        sys.stdin.read()
        server.should_exit = True

    threading.Thread(target=watch_stdin, daemon=True).start()
    print(f"port {sock.getsockname()[1]}", flush=True)
    asyncio.run(server.serve(sockets=[sock]))


if __name__ == "__main__":
    main()
