"""用合成图片检查实际 ddddocr 版本、HTTP 接口和透明边框坐标。"""
import base64
import io
import json
import random
import threading
import unittest
import urllib.error
import urllib.request
from http.server import HTTPServer

from PIL import Image, ImageDraw, ImageFont
from server import Handler


def encoded(picture):
    output = io.BytesIO()
    picture.save(output, format="PNG")
    return base64.b64encode(output.getvalue()).decode()


class BackendTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.url = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def post(self, route, payload):
        request = urllib.request.Request(self.url + route, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"})
        with urllib.request.urlopen(request, timeout=15) as reply:
            return json.load(reply)["result"]

    def test_slide_matches_a_known_patch_and_preserves_alpha_offset(self):
        rng = random.Random(172)
        background = Image.frombytes("RGB", (240, 100), rng.randbytes(240 * 100 * 3))
        piece = Image.new("RGBA", (36, 38))
        piece.paste(background.crop((123, 41, 153, 73)), (3, 4))
        result = self.post("/slide_match", {"target_image": encoded(piece), "background_image": encoded(background)})
        self.assertEqual(result["target_x"], 3)
        self.assertLessEqual(abs(result["target"][0] - result["target_x"] - 120), 1)

    def test_ocr_initializes_and_reuses_the_model(self):
        picture = Image.new("RGB", (140, 52), "white")
        ImageDraw.Draw(picture).text((8, 5), "1234", font=ImageFont.load_default(size=36), fill="black")
        payload = {"image": encoded(picture)}
        first = self.post("/ocr", payload)
        self.assertTrue(first)
        model = Handler.ocr
        self.assertEqual(self.post("/ocr", payload), first)
        self.assertIs(Handler.ocr, model)

    def test_health_and_invalid_input(self):
        with urllib.request.urlopen(self.url + "/health") as reply:
            self.assertEqual(json.load(reply), {"status": "ok"})
        for payload in [{"image": "https://example.invalid/image.png"}, {"image": "AAAA"}, []]:
            with self.assertRaises(urllib.error.HTTPError) as raised:
                self.post("/ocr", payload)
            self.assertEqual(raised.exception.code, 400)


if __name__ == "__main__":
    unittest.main()
