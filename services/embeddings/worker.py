"""One stoppable service: priority query inference + leased, checkpointed backfill."""
import contextlib
import hmac
import json
import logging
import os
import tempfile
import threading
import time
import urllib.error
import urllib.request
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from engine import Engine, PIPELINE, extract_frame, frame_times, video_duration, image_text

LOG = logging.getLogger("embeddings")


class PriorityGate:
    def __init__(self):
        self.condition = threading.Condition()
        self.busy = False
        self.queries = 0

    @contextlib.contextmanager
    def enter(self, query=False):
        with self.condition:
            if query:
                self.queries += 1
            try:
                self.condition.wait_for(lambda: not self.busy and (query or self.queries == 0))
                self.busy = True
            finally:
                if query:
                    self.queries -= 1
        try:
            yield
        finally:
            with self.condition:
                self.busy = False
                self.condition.notify_all()


class Api:
    def __init__(self, base, token):
        self.base = base.rstrip("/") + "/internal/embeddings"
        self.token = token

    def request(self, path, payload=None, claim=None):
        headers = {"Authorization": "Bearer " + self.token}
        if claim:
            headers["X-Claim-Token"] = claim
        body = None
        if payload is not None:
            body = json.dumps(payload, allow_nan=False).encode()
            headers["Content-Type"] = "application/json"
        return urllib.request.urlopen(urllib.request.Request(self.base + path, data=body, headers=headers), timeout=60)

    def post(self, path, payload):
        with self.request(path, payload) as response:
            data = response.read()
            return json.loads(data) if data else None

    def download(self, job, output):
        maximum = 2_147_483_648
        size = 0
        with self.request(f'/{job["id"]}/file', claim=job["claimToken"]) as response, open(output, "wb") as stream:
            expected = int(response.headers["Content-Length"])
            if not 0 < expected <= maximum:
                raise ValueError("Invalid attachment size")
            while chunk := response.read(1024 * 1024):
                size += len(chunk)
                if size > maximum:
                    raise ValueError("Attachment exceeds 2 GiB")
                stream.write(chunk)
        if size != expected:
            raise ValueError("Incomplete attachment download")


class Lease:
    def __init__(self, api, job):
        self.api, self.job = api, job
        self.stop = threading.Event()
        self.lost = threading.Event()

    def __enter__(self):
        def renew():
            while not self.stop.wait(30):
                try:
                    self.api.post(f'/{self.job["id"]}/heartbeat', {"claimToken": self.job["claimToken"]})
                except urllib.error.HTTPError as error:
                    if error.code in (401, 404):
                        self.lost.set()
                        return
                except Exception:
                    LOG.warning("Lease renewal failed; retrying")
        self.thread = threading.Thread(target=renew, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        self.stop.set()
        self.thread.join(timeout=1)

    def check(self):
        if self.lost.is_set():
            raise RuntimeError("Job lease was superseded")


def process(api, engine, gate, job):
    completed = set(job["completed"])
    result_path = f'/{job["id"]}/result'
    claim = {"claimToken": job["claimToken"]}
    with Lease(api, job) as lease, tempfile.TemporaryDirectory(prefix="scratchwall-embedding-") as directory:
        root = Path(directory)

        def checkpoint(unit, vector, timestamp=None):
            lease.check()
            api.post(result_path, {**claim, "unit": unit, "vector": vector, "timestamp": timestamp})

        if job["kind"] in ("text", "ocr"):
            text = job["text"]
            if job["kind"] == "ocr":
                source = root / "source"
                api.download(job, source)
                with gate.enter():
                    text = image_text(source)
            with gate.enter():
                chunks = engine.text_chunks(text) if text.strip() else []
            for index, text in enumerate(chunks):
                lease.check()
                if index not in completed:
                    with gate.enter():
                        vector = engine.text(text)
                    checkpoint(index, vector)
        elif job["kind"] in ("image", "video"):
            source = root / "source"
            api.download(job, source)
            if job["kind"] == "image":
                if 0 not in completed:
                    with gate.enter():
                        vector = engine.image(source)
                    checkpoint(0, vector)
            else:
                for index, timestamp in enumerate(frame_times(video_duration(source))):
                    lease.check()
                    if index in completed:
                        continue
                    frame = root / "frame.jpg"
                    extract_frame(source, timestamp, frame)
                    with gate.enter():
                        vector = engine.image(frame)
                    checkpoint(index, vector, timestamp)
        else:
            raise ValueError("Unsupported embedding source")
        lease.check()
        api.post(result_path, {**claim, "done": True})


def run_jobs(api, engine, gate):
    while True:
        job = None
        try:
            job = api.post("/claim", {"pipeline": PIPELINE})
            if job is None:
                time.sleep(3)
                continue
            process(api, engine, gate, job)
        except Exception as error:
            LOG.warning("Embedding job %s failed (%s)", job["id"] if job else "claim", type(error).__name__)
            if job is not None:
                try:
                    # Do not persist exception strings containing file contents, URLs or credentials.
                    api.post(f'/{job["id"]}/result', {"claimToken": job["claimToken"], "error": type(error).__name__})
                except Exception:
                    pass  # Expiring lease recovers work even when the API is unreachable.
            time.sleep(3)


def serve(engine, gate, token, host="0.0.0.0", port=8090):
    cache = OrderedDict()
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            self.send_response(204 if self.path == "/healthz" else 404)
            self.end_headers()

        def do_POST(self):
            if not hmac.compare_digest(self.headers.get("Authorization", ""), "Bearer " + token):
                self.send_error(401)
                return
            try:
                if self.path != "/query":
                    self.send_error(404)
                    return
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= 32_000:
                    raise ValueError("Invalid request size")
                query = json.loads(self.rfile.read(size))["query"].strip()
                if not 0 < len(query) <= 2000:
                    raise ValueError("Invalid query")
                with gate.enter(query=True):
                    if query not in cache:
                        cache[query] = {"pipeline": PIPELINE, "text": engine.text(query, query=True), "visual": engine.visual_query(query)}
                        if len(cache) > 64:
                            cache.popitem(last=False)
                    cache.move_to_end(query)
                    body = json.dumps(cache[query], allow_nan=False).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass  # Search cancellation or navigation can close the client socket.
            except (ValueError, KeyError, TypeError):
                self.send_error(400)
            except Exception:
                LOG.exception("Query inference failed")
                self.send_error(503)
    return ThreadingHTTPServer((host, port), Handler)


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    token = os.environ["EMBEDDING_TOKEN"]
    if len(token) < 32:
        raise ValueError("EMBEDDING_TOKEN must have at least 32 characters")
    engine = Engine(threads=int(os.environ.get("EMBEDDING_THREADS", "2")))
    gate = PriorityGate()
    api = Api(os.environ.get("SCRATCHWALL_URL", "http://scratchwall:8080"), token)
    threading.Thread(target=run_jobs, args=(api, engine, gate), daemon=True).start()
    LOG.info("Embedding pipeline ready: %s", PIPELINE)
    serve(engine, gate, token).serve_forever()


if __name__ == "__main__":
    main()
