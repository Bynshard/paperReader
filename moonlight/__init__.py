"""Moonlight — local-first paper library with layout-preserving translation.

This package contains the *validation-grade* core that is shared by the M0
harness and the future desktop sidecar:

* :mod:`moonlight.geometry`  — page geometry / coordinate protocol
* :mod:`moonlight.corpus`    — frozen corpus manifest (sha256, page geometry)
* :mod:`moonlight.engine`    — BabelDOC translation adapter (subprocess)
* :mod:`moonlight.gateway`   — local OpenAI-compatible model gateway
* :mod:`moonlight.manifest`  — run/block status model and artifacts manifest
* :mod:`moonlight.metrics`   — coverage, font-size and geometry measurements
* :mod:`moonlight.render`    — page rendering and comparison composites
* :mod:`moonlight.validate`  — M0 orchestration and evidence collection
* :mod:`moonlight.sidecar`   — JSONL control protocol for the desktop app
"""

__version__ = "0.1.0"
PROTOCOL_VERSION = 1
