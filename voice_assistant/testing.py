class FakeRecognizer:
    def __init__(self, model_path=None):
        self.model_path = model_path
        self.device = ""

    def load(self, requested_device="auto"):
        self.device = "cpu" if requested_device == "auto" else requested_device
        return self.device

    def transcribe(self, pcm16, language):
        if not pcm16:
            return ""

        duration_seconds = len(pcm16) / (16_000 * 2)
        if duration_seconds < 4:
            return "测试"
        if duration_seconds < 4.8:
            return "测试语音"
        return "测试语音完成。"

    def close(self):
        self.device = ""


class FakeVad:
    def is_speech(self, frame):
        return any(frame)
