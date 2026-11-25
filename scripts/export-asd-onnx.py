#!/usr/bin/env python3
"""Export LR-ASD (active speaker detection) to ONNX for onnxruntime-node.

LR-ASD is a lightweight audio-visual active speaker detection model:

    "LR-ASD: Lightweight and Robust Network for Active Speaker Detection"
    Junhua Liao, Haihan Duan, Kanghui Feng, Wanbing Zhao, Yanbing Yang,
    Liangyin Chen, Yanru Chen. IJCV 2025.
    https://github.com/Junhua-Liao/LR-ASD  (MIT license - code AND weights,
    see models/lr-asd/LR-ASD-LICENSE.txt)

This is a ONE-TIME developer step - the app never runs Python. It produces two
graphs in models/lr-asd/ (gitignored, like every other model):

  lr-asd-frontend.onnx  audio [1,Ta,13] + video [1,Tv,112,112]
                        -> embedA [1,Tv,128] + embedV [1,Tv,128]
  lr-asd-backend.onnx   embedA + embedV -> scoresAV [Tv] + scoresV [Tv]

Splitting frontend/backend is not an accuracy change: it lets the worker run the
(heavy) encoders once per face track and then ensemble the (tiny) recurrent
backend over several window lengths, exactly like the reference
`Columbia_test.py` multi-duration evaluation. `npm run setup:asd` downloads the
official weights and calls this script.

Preprocessing the worker must replicate (see worker/asd/lr-asd.ts):
  - 13-coefficient MFCC at 16 kHz, winlen 0.025 s, winstep 0.010 s
    -> 100 MFCC frames per second, 4 per 25 fps video frame;
  - 112x112 GRAYSCALE face crops at 25 fps, taken from a square of
    0.7 x max(boxW, boxH) centred on the face and shifted down by
    0.2 x max(boxW, boxH) (the reference `crop_video`), zero-padded with 110;
  - the visual frontend normalises internally: (x / 255 - 0.4161) / 0.1688.

Model definition below is vendored from https://github.com/Junhua-Liao/LR-ASD
(MIT) with one change: the audio encoder's MaxPool3d layers (which relied on
PyTorch's "a 4D input to MaxPool3d is treated as unbatched" behaviour) are
replaced by mathematically equivalent MaxPool2d layers so the ONNX export is
clean. Pooling layers carry no weights, so the published checkpoint loads
unchanged.

Usage:
  python scripts/export-asd-onnx.py [--weights path/to/finetuning_TalkSet.model
                                    | --weights path/to/pretrain_AVA.model]
  python scripts/export-asd-onnx.py --write-fixtures   # also refresh the parity
                                                      # fixtures used by the tests

Requires (developer machine only): torch, onnx, onnxruntime, numpy, and
python_speech_features for the fixtures.
"""

import argparse
import json
import math
import os
import sys
import urllib.request

import numpy as np
import torch
import torch.nn as nn

WEIGHTS_URL = (
    "https://github.com/Junhua-Liao/LR-ASD/raw/main/weight/finetuning_TalkSet.model"
)
AVA_WEIGHTS_URL = (
    "https://github.com/Junhua-Liao/LR-ASD/raw/main/weight/pretrain_AVA.model"
)
REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS_DIR = os.path.join(REPO_ROOT, "models", "lr-asd")
FIXTURES_DIR = os.path.join(REPO_ROOT, "tests", "fixtures")


# ---------------------------------------------------------------------------
# Model definition (vendored from https://github.com/Junhua-Liao/LR-ASD, MIT)
# ---------------------------------------------------------------------------


class AudioBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_1, kernel_2):
        super().__init__()
        self.relu = nn.ReLU()
        p1 = (kernel_1 - 1) // 2
        p2 = (kernel_2 - 1) // 2
        self.m_1 = nn.Conv2d(in_channels, out_channels // 2, (kernel_1, 1), padding=(p1, 0), bias=False)
        self.m_norm_1 = nn.BatchNorm2d(out_channels // 2, momentum=0.01, eps=0.001)
        self.m_2 = nn.Conv2d(out_channels // 2, out_channels, (kernel_2, 1), padding=(p2, 0), bias=False)
        self.m_norm_2 = nn.BatchNorm2d(out_channels, momentum=0.01, eps=0.001)
        self.t_1 = nn.Conv2d(out_channels, out_channels, (1, kernel_1), padding=(0, p1), bias=False)
        self.t_norm_1 = nn.BatchNorm2d(out_channels, momentum=0.01, eps=0.001)
        self.t_2 = nn.Conv2d(out_channels, out_channels, (1, kernel_2), padding=(0, p2), bias=False)
        self.t_norm_2 = nn.BatchNorm2d(out_channels, momentum=0.01, eps=0.001)

    def forward(self, x):
        x = self.relu(self.m_norm_1(self.m_1(x)))
        x = self.relu(self.m_norm_2(self.m_2(x)))
        x = self.relu(self.t_norm_1(self.t_1(x)))
        x = self.relu(self.t_norm_2(self.t_2(x)))
        return x


class VisualBlock(nn.Module):
    def __init__(self, in_channels, out_channels, kernel_1, kernel_2, is_down=False):
        super().__init__()
        self.relu = nn.ReLU()
        p1 = (kernel_1 - 1) // 2
        p2 = (kernel_2 - 1) // 2
        stride = (1, 2, 2) if is_down else (1, 1, 1)
        self.s_1 = nn.Conv3d(in_channels, out_channels // 2, (1, kernel_1, kernel_1), stride=stride, padding=(0, p1, p1), bias=False)
        self.s_norm_1 = nn.BatchNorm3d(out_channels // 2, momentum=0.01, eps=0.001)
        self.s_2 = nn.Conv3d(out_channels // 2, out_channels, (1, kernel_2, kernel_2), padding=(0, p2, p2), bias=False)
        self.s_norm_2 = nn.BatchNorm3d(out_channels, momentum=0.01, eps=0.001)
        self.t_1 = nn.Conv3d(out_channels, out_channels, (kernel_1, 1, 1), padding=(p1, 0, 0), bias=False)
        self.t_norm_1 = nn.BatchNorm3d(out_channels, momentum=0.01, eps=0.001)
        self.t_2 = nn.Conv3d(out_channels, out_channels, (kernel_2, 1, 1), padding=(p2, 0, 0), bias=False)
        self.t_norm_2 = nn.BatchNorm3d(out_channels, momentum=0.01, eps=0.001)

    def forward(self, x):
        x = self.relu(self.s_norm_1(self.s_1(x)))
        x = self.relu(self.s_norm_2(self.s_2(x)))
        x = self.relu(self.t_norm_1(self.t_1(x)))
        x = self.relu(self.t_norm_2(self.t_2(x)))
        return x


class VisualEncoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.block1 = VisualBlock(1, 32, 5, 3, is_down=True)
        self.pool1 = nn.MaxPool3d((1, 3, 3), stride=(1, 2, 2), padding=(0, 1, 1))
        self.block2 = VisualBlock(32, 64, 5, 3)
        self.pool2 = nn.MaxPool3d((1, 3, 3), stride=(1, 2, 2), padding=(0, 1, 1))
        self.block3 = VisualBlock(64, 128, 5, 3)

    def forward(self, x):
        x = self.block1(x)
        x = self.pool1(x)
        x = self.block2(x)
        x = self.pool2(x)
        x = self.block3(x)
        # [B, C, T, H, W] -> global spatial max -> [B, T, C]
        x = torch.amax(x, dim=(3, 4))
        return x.transpose(1, 2)


class AudioEncoder(nn.Module):
    def __init__(self):
        super().__init__()
        self.block1 = AudioBlock(1, 32, 5, 3)
        # Upstream uses MaxPool3d on a 4D tensor, which PyTorch reads as an
        # unbatched (C,D,H,W) input pooled along W (time). MaxPool2d over
        # (freq=1, time=3) is identical and exports cleanly.
        self.pool1 = nn.MaxPool2d((1, 3), stride=(1, 2), padding=(0, 1))
        self.block2 = AudioBlock(32, 64, 5, 3)
        self.pool2 = nn.MaxPool2d((1, 3), stride=(1, 2), padding=(0, 1))
        self.block3 = AudioBlock(64, 128, 5, 3)

    def forward(self, x):
        x = self.block1(x)
        x = self.pool1(x)
        x = self.block2(x)
        x = self.pool2(x)
        x = self.block3(x)
        x = torch.mean(x, dim=2)  # average over frequency -> [B, C, T]
        return x.transpose(1, 2)


class Fusion(nn.Module):
    def __init__(self, channel):
        super().__init__()
        self.sigmoid = nn.Sigmoid()
        self.attention = nn.Conv1d(channel, channel, kernel_size=1, padding=0, bias=False)
        self.bn = nn.BatchNorm1d(channel, momentum=0.01, eps=0.001)

    def forward(self, x1, x2):
        x = torch.cat((x1, x2), 2)
        identity = x.transpose(1, 2)
        w = self.sigmoid(self.bn(self.attention(identity)))
        return (identity * w).transpose(1, 2)


class Detector(nn.Module):
    def __init__(self, channel):
        super().__init__()
        self.gru_forward = nn.GRU(channel, channel // 4, num_layers=1, bias=True, batch_first=True)
        self.gru_backward = nn.GRU(channel, channel // 4, num_layers=1, bias=True, batch_first=True)
        self.drop = nn.Dropout(0.5)
        self.attention = Fusion(channel // 2)

    def forward(self, x):
        x1, _ = self.gru_forward(self.drop(x))
        x = torch.flip(x, dims=[1])
        x2, _ = self.gru_backward(self.drop(x))
        x2 = torch.flip(x2, dims=[1])
        return self.attention(x1, x2)


class ASDModel(nn.Module):
    def __init__(self):
        super().__init__()
        self.visualEncoder = VisualEncoder()
        self.audioEncoder = AudioEncoder()
        self.fusion = Fusion(256)
        self.detector = Detector(256)

    def forward_visual_frontend(self, x):
        B, T, W, H = x.shape
        x = x.view(B, 1, T, W, H)
        x = (x / 255 - 0.4161) / 0.1688
        return self.visualEncoder(x)

    def forward_audio_frontend(self, x):
        x = x.unsqueeze(1).transpose(2, 3)
        return self.audioEncoder(x)

    def forward_audio_visual_backend(self, x1, x2):
        x = self.fusion(x1, x2)
        x = self.detector(x)
        return torch.reshape(x, (-1, 128))


# ---------------------------------------------------------------------------
# Export wrappers
# ---------------------------------------------------------------------------


class Frontend(nn.Module):
    """Audio + visual feature encoders (the compute-heavy stages)."""

    def __init__(self, model: ASDModel):
        super().__init__()
        self.model = model

    def forward(self, audio, video):
        embed_a = self.model.forward_audio_frontend(audio)
        embed_v = self.model.forward_visual_frontend(video)
        return embed_a, embed_v


class Backend(nn.Module):
    """Fusion + bidirectional GRU detector + classifier heads.

    Emits the raw class-1 logit per frame, matching the reference
    implementation's `lossAV.forward(x, labels=None)` scoring (speaking when the
    score is above 0). `scoresV` is the visual-only head used when the source has
    no audio track.
    """

    def __init__(self, model: ASDModel, fc_av: nn.Linear, fc_v: nn.Linear):
        super().__init__()
        self.model = model
        self.fc_av = fc_av
        self.fc_v = fc_v

    def forward(self, embed_a, embed_v):
        out_av = self.model.forward_audio_visual_backend(embed_a, embed_v)
        scores_av = self.fc_av(out_av)[:, 1]
        scores_v = self.fc_v(torch.reshape(embed_v, (-1, 128)))[:, 1]
        return scores_av, scores_v


def load_weights(path: str):
    state = torch.load(path, map_location="cpu", weights_only=True)
    model = ASDModel()
    fc_av = nn.Linear(128, 2)
    fc_v = nn.Linear(128, 2)
    model_state = {}
    for name, param in state.items():
        name = name.replace("module.", "")
        if name.startswith("model."):
            model_state[name[len("model."):]] = param
        elif name == "lossAV.FC.weight":
            fc_av.weight.data.copy_(param)
        elif name == "lossAV.FC.bias":
            fc_av.bias.data.copy_(param)
        elif name == "lossV.FC.weight":
            fc_v.weight.data.copy_(param)
        elif name == "lossV.FC.bias":
            fc_v.bias.data.copy_(param)
    missing, unexpected = model.load_state_dict(model_state, strict=False)
    # Pooling swaps are weightless; anything else missing means a mismatch.
    if missing or unexpected:
        raise RuntimeError(f"state dict mismatch: missing={missing} unexpected={unexpected}")
    model.eval()
    fc_av.eval()
    fc_v.eval()
    return model, fc_av, fc_v


def export(model, fc_av, fc_v):
    os.makedirs(MODELS_DIR, exist_ok=True)
    frontend_path = os.path.join(MODELS_DIR, "lr-asd-frontend.onnx")
    backend_path = os.path.join(MODELS_DIR, "lr-asd-backend.onnx")

    tv, ta = 50, 200
    audio = torch.randn(1, ta, 13)
    video = torch.randn(1, tv, 112, 112) * 40 + 110

    frontend = Frontend(model).eval()
    torch.onnx.export(
        frontend,
        (audio, video),
        frontend_path,
        input_names=["audio", "video"],
        output_names=["embedA", "embedV"],
        dynamic_axes={
            "audio": {1: "ta"},
            "video": {1: "tv"},
            "embedA": {1: "tv"},
            "embedV": {1: "tv"},
        },
        opset_version=17,
        dynamo=False,
    )

    backend = Backend(model, fc_av, fc_v).eval()
    embed_a, embed_v = frontend(audio, video)
    torch.onnx.export(
        backend,
        (embed_a, embed_v),
        backend_path,
        input_names=["embedA", "embedV"],
        output_names=["scoresAV", "scoresV"],
        dynamic_axes={
            "embedA": {1: "tv"},
            "embedV": {1: "tv"},
            "scoresAV": {0: "tv"},
            "scoresV": {0: "tv"},
        },
        opset_version=17,
        dynamo=False,
    )
    return frontend_path, backend_path


def verify(model, fc_av, fc_v, frontend_path, backend_path) -> None:
    import onnxruntime as ort

    frontend = Frontend(model).eval()
    backend = Backend(model, fc_av, fc_v).eval()
    sess_f = ort.InferenceSession(frontend_path, providers=["CPUExecutionProvider"])
    sess_b = ort.InferenceSession(backend_path, providers=["CPUExecutionProvider"])

    rng = np.random.default_rng(7)
    for tv in (25, 75, 150):
        ta = tv * 4
        audio = rng.standard_normal((1, ta, 13)).astype(np.float32)
        video = (rng.standard_normal((1, tv, 112, 112)) * 40 + 110).astype(np.float32)
        with torch.no_grad():
            ta_ref, tv_ref = frontend(torch.from_numpy(audio), torch.from_numpy(video))
            av_ref, v_ref = backend(ta_ref, tv_ref)
        ea, ev = sess_f.run(None, {"audio": audio, "video": video})
        av, v = sess_b.run(None, {"embedA": ea, "embedV": ev})
        for got, ref, name in (
            (ea, ta_ref.numpy(), "embedA"),
            (ev, tv_ref.numpy(), "embedV"),
            (av, av_ref.numpy(), "scoresAV"),
            (v, v_ref.numpy(), "scoresV"),
        ):
            err = float(np.max(np.abs(got - ref)))
            if err > 2e-3:
                raise RuntimeError(f"ONNX/torch mismatch for {name} at tv={tv}: {err}")
        print(f"  parity ok at tv={tv}: scoresAV range [{av.min():.2f}, {av.max():.2f}]")


def write_fixtures():
    """Deterministic fixtures that let the TS code be validated without torch.

    mfcc-fixture.json      PCM -> MFCC (python_speech_features) for the TS MFCC.
    lr-asd-parity.json     preprocessed inputs + the PyTorch scores/embeddings,
                           so a Node test can check ONNX agrees with torch.
    """
    import python_speech_features

    os.makedirs(FIXTURES_DIR, exist_ok=True)
    rng = np.random.default_rng(42)
    n = 16000  # one second at 16 kHz
    t = np.arange(n) / 16000.0
    wave = (
        6000 * np.sin(2 * math.pi * 220 * t)
        + 2500 * np.sin(2 * math.pi * 1330 * t + 0.5)
        + 800 * rng.standard_normal(n)
    )
    pcm = np.clip(wave, -32768, 32767).astype(np.int16)
    mfcc = python_speech_features.mfcc(pcm, 16000, numcep=13, winlen=0.025, winstep=0.010)
    with open(os.path.join(FIXTURES_DIR, "mfcc-fixture.json"), "w") as f:
        json.dump(
            {
                "sampleRate": 16000,
                "winlen": 0.025,
                "winstep": 0.010,
                "pcm": pcm.tolist(),
                "mfcc": [[round(float(v), 6) for v in row] for row in mfcc],
            },
            f,
        )
    print(f"  wrote mfcc fixture ({mfcc.shape[0]} frames)")

    # A short, deterministic clip-shaped sample: 8 video frames @25fps = 0.32 s,
    # 32 MFCC frames, and 8 grayscale 112x112 crops.
    frames = 8
    audio = rng.standard_normal((1, frames * 4, 13)).astype(np.float32) * 8
    video = np.clip(
        rng.standard_normal((1, frames, 112, 112)) * 25 + 118, 0, 255
    ).astype(np.float32)
    model, fc_av, fc_v = load_weights(os.path.join(MODELS_DIR, "lr-asd-weights.pt"))
    with torch.no_grad():
        embed_a, embed_v = Frontend(model).eval()(
            torch.from_numpy(audio), torch.from_numpy(video)
        )
        scores_av, scores_v = Backend(model, fc_av, fc_v).eval()(embed_a, embed_v)
    with open(os.path.join(FIXTURES_DIR, "lr-asd-parity.json"), "w") as f:
        json.dump(
            {
                "audio": audio.reshape(-1).tolist(),
                "video": video.reshape(-1).tolist(),
                "frames": frames,
                "scoresAV": [round(float(v), 6) for v in scores_av.numpy()],
                "scoresV": [round(float(v), 6) for v in scores_v.numpy()],
                "embedA": [round(float(v), 6) for v in embed_a.numpy().reshape(-1)],
                "embedV": [round(float(v), 6) for v in embed_v.numpy().reshape(-1)],
            },
            f,
        )
    print("  wrote lr-asd parity fixture")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--weights", default=None, help="path to a LR-ASD .model checkpoint")
    parser.add_argument("--ava", action="store_true", help="use the AVA weights instead of TalkSet")
    parser.add_argument(
        "--write-fixtures",
        action="store_true",
        help="also regenerate tests/fixtures mfcc + lr-asd parity fixtures",
    )
    args = parser.parse_args()

    weights = args.weights
    if weights is None:
        target = os.path.join(MODELS_DIR, "lr-asd-weights.pt")
        if not os.path.exists(target):
            url = AVA_WEIGHTS_URL if args.ava else WEIGHTS_URL
            os.makedirs(MODELS_DIR, exist_ok=True)
            print(f"downloading weights from {url}")
            urllib.request.urlretrieve(url, target)
        weights = target

    print("loading weights")
    model, fc_av, fc_v = load_weights(weights)
    print("exporting ONNX")
    frontend_path, backend_path = export(model, fc_av, fc_v)
    print("verifying ONNX against PyTorch")
    verify(model, fc_av, fc_v, frontend_path, backend_path)
    if args.write_fixtures:
        print("writing fixtures")
        # write_fixtures expects the downloaded checkpoint under its own name.
        target = os.path.join(MODELS_DIR, "lr-asd-weights.pt")
        if os.path.abspath(weights) != os.path.abspath(target):
            import shutil

            shutil.copyfile(weights, target)
        write_fixtures()
    for p in (frontend_path, backend_path):
        print(f"  {p}: {os.path.getsize(p) / 1e6:.2f} MB")
    print("done")


if __name__ == "__main__":
    sys.exit(main())
