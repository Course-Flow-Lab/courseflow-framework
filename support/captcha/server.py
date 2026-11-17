"""Courseflow 本地验证码后端；串行复用模型，不接收平台凭据或远程图片地址。"""
import argparse
import base64
import binascii
import io
import json
from http.server import BaseHTTPRequestHandler, HTTPServer

import ddddocr
from PIL import Image, UnidentifiedImageError

MAX_IMAGE = 2 * 1024 * 1024
MAX_BODY = 6 * 1024 * 1024
Image.MAX_IMAGE_PIXELS = 4096 * 4096


def image(value):
    if not isinstance(value, str) or len(value) > ((MAX_IMAGE + 2) // 3) * 4:
        raise ValueError("验证码图片过大或格式无效")
    data = base64.b64decode(value, validate=True)
    if not data or len(data) > MAX_IMAGE:
        raise ValueError("验证码图片为空或过大")
    with Image.open(io.BytesIO(data)) as picture:
        if picture.width > 4096 or picture.height > 4096 or picture.format not in {"PNG", "JPEG", "WEBP", "BMP"}:
            raise ValueError("验证码图片尺寸或格式无效")
        picture.verify()
    return data


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"
    slide = None
    ocr = None

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_args):
        pass

    def reply(self, status, value):
        body = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.reply(200, {"status": "ok"}) if self.path == "/health" else self.reply(404, {"error": "not_found"})

    def do_POST(self):
        if self.path not in {"/ocr", "/slide_match"}:
            self.reply(404, {"error": "not_found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                raise ValueError("请求体为空或过大")
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("请求体必须是对象")
            if self.path == "/ocr":
                data = image(payload.get("image"))
                if Handler.ocr is None:
                    Handler.ocr = ddddocr.DdddOcr(show_ad=False)
                result = Handler.ocr.classification(data)
            else:
                target, background = image(payload.get("target_image")), image(payload.get("background_image"))
                if Handler.slide is None:
                    Handler.slide = ddddocr.DdddOcr(ocr=False, det=False, show_ad=False)
                result = Handler.slide.slide_match(target, background, simple_target=payload.get("simple_target") is True)
            self.reply(200, {"result": result})
        except (ValueError, binascii.Error, UnidentifiedImageError, Image.DecompressionBombError, OSError):
            self.reply(400, {"error": "invalid_image_or_request"})
        except Exception:
            # Do not expose input images or library exception payloads in responses/logs.
            self.reply(500, {"error": "recognition_failed"})


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8190)
    args = parser.parse_args()
    with HTTPServer((args.host, args.port), Handler) as server:
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass
