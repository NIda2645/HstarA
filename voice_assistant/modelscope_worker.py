import argparse
import json
import sys
from pathlib import Path


def bootstrap_runtime(runtime_site: str) -> None:
    resolved = str(Path(runtime_site).resolve())
    if resolved not in sys.path:
        sys.path.insert(0, resolved)


def download(model_id: str, revision: str, staging_dir: str) -> str:
    from modelscope import snapshot_download

    return snapshot_download(
        model_id,
        revision=revision or "master",
        local_dir=str(Path(staging_dir).resolve()),
    )


def smoke(model_path: str, device: str) -> str:
    from funasr import AutoModel

    path = Path(model_path).resolve()
    model = AutoModel(
        model=str(path),
        trust_remote_code=True,
        device="cuda:0" if device == "cuda" else "cpu",
    )
    example = path / "example" / "zh.mp3"
    result = model.generate(input=[str(example)], cache={}, batch_size=1, itn=True)
    text = str(result[0].get("text") or "").strip()
    if not text:
        raise RuntimeError("FunASR smoke test returned an empty transcript")
    return text


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("download", "smoke"))
    parser.add_argument("--runtime-site", required=True)
    parser.add_argument("--model-id", default="")
    parser.add_argument("--revision", default="master")
    parser.add_argument("--model-path", default="")
    parser.add_argument("--staging-dir", default="")
    parser.add_argument("--device", choices=("cuda", "cpu"), default="cpu")
    args = parser.parse_args()
    bootstrap_runtime(args.runtime_site)
    if args.action == "download":
        if not args.model_id or not args.staging_dir:
            parser.error("download requires --model-id and --staging-dir")
        result = {"model_path": download(args.model_id, args.revision, args.staging_dir)}
    else:
        if not args.model_path:
            parser.error("smoke requires --model-path")
        result = {"text": smoke(args.model_path, args.device)}
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
