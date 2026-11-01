"""Command line entry points.

    python -m moonlight freeze   --spec corpus.spec.json --out corpus/corpus.json
    python -m moonlight inspect  --pdf x.pdf --pages 1-6
    python -m moonlight run-m0   --corpus corpus/corpus.json --out artifacts/validation
    python -m moonlight gateway  --provider fake --port 4010
    python -m moonlight sidecar  --stdio

``--provider fake`` uses the deterministic offline provider: it exercises the
whole engine/task/commit path without spending money and is the basis of the
fault-injection tests.  Real translation requires ``MOONLIGHT_UPSTREAM_KEY``
(or ``--key-env``) to point at a valid OpenAI-compatible endpoint.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import pymupdf

from . import __version__
from .corpus import build_manifest, freeze_sample, profile_page
from .engine import DEFAULT_MODEL, DEFAULT_UPSTREAM, EngineConfig


def cmd_freeze(args: argparse.Namespace) -> int:
    spec = json.loads(Path(args.spec).read_text(encoding="utf-8"))
    samples = []
    for entry in spec["samples"]:
        path = Path(entry["path"])
        if not path.is_absolute():
            path = Path(args.spec).parent / path
        sample = freeze_sample(
            path,
            sample_id=entry["id"],
            title=entry["title"],
            source=entry.get("source", {}),
            kind=entry.get("kind", "core"),
            selected_pages=entry.get("selected_pages", []),
            notes=entry.get("notes", ""),
            annotate=entry.get("annotate", True),
        )
        samples.append(sample)
        print(f"frozen {entry['id']}: {sample['pages_total']} pages, sha256={sample['source']['sha256'][:16]}…")
    build_manifest(samples, args.out)
    print(f"manifest: {args.out}")
    return 0


def cmd_inspect(args: argparse.Namespace) -> int:
    doc = pymupdf.open(args.pdf)
    try:
        if args.pages:
            first, _, last = args.pages.partition("-")
            a = int(first) - 1
            b = int(last) - 1 if last else a
        else:
            a, b = 0, doc.page_count - 1
        for i in range(max(0, a), min(doc.page_count, b + 1)):
            prof = profile_page(doc[i])
            print(json.dumps(prof, ensure_ascii=False))
    finally:
        doc.close()
    return 0


def _engine_config(args: argparse.Namespace) -> EngineConfig:
    cfg = EngineConfig(
        model=args.model,
        upstream=args.upstream,
        key_env=args.key_env,
        provider=args.provider,
        qps=args.qps,
        babeldoc_bin=args.babeldoc_bin,
        timeout_s=args.timeout,
    )
    if getattr(args, "extra_args", None):
        cfg.extra_args = args.extra_args
    return cfg


def cmd_run_m0(args: argparse.Namespace) -> int:
    from .validate import run_m0

    result = run_m0(
        args.corpus,
        args.out,
        _engine_config(args),
        sample_ids=args.samples.split(",") if args.samples else None,
        pages=args.pages,
        reuse=args.reuse,
        dpi=args.dpi,
        limit_pages=args.limit_pages,
        run_id=args.run_id,
        edge_cases=not args.no_edge_cases,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] in ("pass",) else (0 if args.allow_not_run and result["status"] == "not_run" else 1)


def cmd_translate(args: argparse.Namespace) -> int:
    from .engine import BabelDocEngine

    engine = BabelDocEngine(_engine_config(args))
    result = engine.translate(args.pdf, args.out, pages=args.pages, progress=lambda e: print(json.dumps(e), flush=True))
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "completed" else 1


def cmd_gateway(args: argparse.Namespace) -> int:
    from .gateway import main as gateway_main

    return gateway_main(args.rest)


def cmd_sidecar(args: argparse.Namespace) -> int:
    from .sidecar import main as sidecar_main

    return sidecar_main([])


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="moonlight", description=f"Moonlight paper tooling {__version__}")
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("freeze", help="freeze corpus manifest (sha256, geometry, annotations)")
    p.add_argument("--spec", required=True)
    p.add_argument("--out", required=True)
    p.set_defaults(func=cmd_freeze)

    p = sub.add_parser("inspect", help="print per-page profiles")
    p.add_argument("--pdf", required=True)
    p.add_argument("--pages")
    p.set_defaults(func=cmd_inspect)

    def engine_args(p: argparse.ArgumentParser) -> None:
        p.add_argument("--model", default=DEFAULT_MODEL)
        p.add_argument("--upstream", default=DEFAULT_UPSTREAM)
        p.add_argument("--key-env", default="MOONLIGHT_UPSTREAM_KEY")
        p.add_argument("--provider", choices=["openai", "fake"], default="openai")
        p.add_argument("--qps", type=int, default=4)
        p.add_argument("--timeout", type=int, default=3600)
        p.add_argument("--babeldoc-bin")

    p = sub.add_parser("run-m0", help="translate corpus samples and collect M0 evidence")
    p.add_argument("--corpus", required=True)
    p.add_argument("--out", default="artifacts/validation")
    engine_args(p)
    p.add_argument("--samples")
    p.add_argument("--pages")
    p.add_argument("--reuse", action="store_true")
    p.add_argument("--limit-pages", action="store_true", help="translate only the annotated pages")
    p.add_argument("--dpi", type=int, default=110)
    p.add_argument("--run-id")
    p.add_argument("--no-edge-cases", action="store_true")
    p.add_argument("--allow-not-run", action="store_true")
    p.add_argument("--extra-args", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_run_m0)

    p = sub.add_parser("translate", help="translate one PDF")
    p.add_argument("--pdf", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--pages")
    engine_args(p)
    p.add_argument("--extra-args", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_translate)

    p = sub.add_parser("gateway", help="run the local model gateway")
    p.add_argument("rest", nargs=argparse.REMAINDER)
    p.set_defaults(func=cmd_gateway)

    p = sub.add_parser("sidecar", help="run the JSONL sidecar protocol on stdio")
    p.set_defaults(func=cmd_sidecar)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    return int(args.func(args) or 0)


if __name__ == "__main__":
    sys.exit(main())
