import json
import io
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from unittest.mock import patch
from pathlib import Path

from engine import PIPELINE, chunk_spans, frame_times
from worker import Api, PriorityGate, process, serve


class FakeEngine:
    def __init__(self):
        self.calls = []
    def text_chunks(self, text):
        return ["one", "two", "three"]
    def text(self, text, query=False):
        self.calls.append(text)
        return [1.0] * 768
    def visual_query(self, text):
        return [1.0] * 1024
    def image(self, path):
        self.calls.append(str(path))
        return [1.0] * 1024


class FakeApi:
    def __init__(self, fail_unit=None):
        self.units = {}
        self.done = False
        self.fail_unit = fail_unit
    def post(self, path, payload):
        if "unit" in payload:
            if payload["unit"] == self.fail_unit:
                raise ConnectionError("simulated interruption")
            self.units[payload["unit"]] = payload
        self.done |= payload.get("done", False)
    def download(self, job, output):
        output.write_bytes(b"test")


class WorkerTests(unittest.TestCase):
    def test_download_rejects_an_interrupted_file(self):
        response=io.BytesIO(b"abc")
        response.headers={"Content-Length":"10"}
        api=Api("http://localhost","token")
        with patch.object(api,"request",return_value=response), tempfile.TemporaryDirectory() as directory:
            with self.assertRaisesRegex(ValueError,"Incomplete"):
                api.download({"id":1,"claimToken":"x"},Path(directory)/"file")

    def test_chunks_preserve_tail_without_truncation(self):
        self.assertEqual(list(chunk_spans(0)), [])
        self.assertEqual(list(chunk_spans(385)), [(0,384),(320,385)])
        self.assertEqual(list(chunk_spans(384)), [(0,384)])
        spans=list(chunk_spans(2000))
        self.assertEqual(spans[-1][1],2000)
        for left,right in zip(spans,spans[1:]):
            self.assertEqual(left[1]-right[0],64)

    def test_sampling_is_deterministic_bounded_and_covers_whole_clip(self):
        self.assertEqual(frame_times(1),[.5])
        times=frame_times(3600)
        self.assertEqual(len(times),32)
        self.assertEqual(times,frame_times(3600))
        self.assertLess(times[0],120)
        self.assertGreater(times[-1],3480)
        for duration in [0,-1,float("inf"),float("nan")]:
            with self.assertRaises(ValueError):
                frame_times(duration)

    def test_interrupted_text_job_resumes_only_unfinished_units(self):
        engine=FakeEngine(); api=FakeApi(fail_unit=1)
        job={"id":1,"claimToken":"first","kind":"text","text":"memo","completed":[]}
        with self.assertRaises(ConnectionError):
            process(api,engine,PriorityGate(),job)
        self.assertEqual(list(api.units),[0]); self.assertFalse(api.done)
        engine.calls.clear(); api.fail_unit=None
        process(api,engine,PriorityGate(),{**job,"claimToken":"second","completed":[0]})
        self.assertEqual(engine.calls,["two","three"])
        self.assertEqual(list(api.units),[0,1,2]); self.assertTrue(api.done)

    def test_video_resumes_frames_and_preserves_timestamps(self):
        engine=FakeEngine(); api=FakeApi()
        job={"id":1,"claimToken":"x","kind":"video","text":"","completed":[0,1]}
        with patch("worker.video_duration",return_value=15), patch("worker.extract_frame") as extract:
            process(api,engine,PriorityGate(),job)
        self.assertEqual(list(api.units),[2]); self.assertEqual(api.units[2]["timestamp"],11.25)
        self.assertEqual(extract.call_count,1); self.assertTrue(api.done)

    def test_ocr_is_checkpointed_as_text_without_changing_memo_content(self):
        engine=FakeEngine(); api=FakeApi(fail_unit=1)
        job={"id":1,"claimToken":"x","kind":"ocr","text":"","completed":[]}
        with patch("worker.image_text",return_value="вкусно и кошька") as ocr:
            with self.assertRaises(ConnectionError):
                process(api,engine,PriorityGate(),job)
            self.assertEqual(list(api.units),[0])
            api.fail_unit=None; engine.calls.clear()
            process(api,engine,PriorityGate(),{**job,"completed":[0]})
        self.assertEqual(engine.calls,["two","three"])
        self.assertTrue(api.done)
        self.assertEqual(job["text"],"")

    def test_image_without_ocr_text_completes_without_inventing_vector(self):
        api=FakeApi()
        with patch("worker.image_text",return_value=""):
            process(api,FakeEngine(),PriorityGate(),{"id":1,"claimToken":"x","kind":"ocr","text":"","completed":[]})
        self.assertEqual(api.units,{})
        self.assertTrue(api.done)

    def test_query_endpoint_authentication_pipeline_and_cache(self):
        engine=FakeEngine(); server=serve(engine,PriorityGate(),"test-token",host="127.0.0.1",port=0)
        thread=threading.Thread(target=server.serve_forever,daemon=True); thread.start()
        url=f"http://127.0.0.1:{server.server_port}/query"
        try:
            def query(token):
                request=urllib.request.Request(url,data=b'{"query":"cats"}',headers={"Authorization":"Bearer "+token})
                return urllib.request.urlopen(request,timeout=3)
            with self.assertRaises(urllib.error.HTTPError) as caught:
                query("wrong")
            self.assertEqual(caught.exception.code,401)
            caught.exception.close()
            for _ in range(2):
                with query("test-token") as result:
                    data=json.loads(result.read())
                    self.assertEqual(data["pipeline"],PIPELINE)
                    self.assertEqual(len(data["visual"]),1024)
            self.assertEqual(engine.calls,["cats"])
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
