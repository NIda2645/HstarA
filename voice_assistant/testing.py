class FakeRecognizer:
    def __init__(self, model_path=None):
        self.model_path = model_path
        self.device = ""

    def load(self, requested_device="auto"):
        self.device = "cpu" if requested_device == "auto" else requested_device
        return self.device

    def transcribe(self, pcm16, language):
        return "测试完成。" if pcm16 else ""

    def close(self):
        self.device = ""


class FakeVad:
    def is_speech(self, frame):
        return any(frame)
