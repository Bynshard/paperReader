"""Offline protocol smoke using a real PDF and an isolated temporary library."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    env = {key: value for key, value in os.environ.items() if not key.startswith("MOONLIGHT_")}
    with tempfile.TemporaryDirectory(prefix="moonlight-smoke-") as directory:
        process = subprocess.Popen(
            [str(ROOT / "core/target/release/moonlight-core"), "--root", directory],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, env=env,
        )
        assert process.stdin and process.stdout
        counter = 0

        def call(method: str, **params):
            nonlocal counter
            counter += 1
            process.stdin.write(json.dumps(dict(id=counter, method=method, params=params)) + "\n")
            process.stdin.flush()
            for line in process.stdout:
                reply = json.loads(line)
                if reply.get("id") == counter:
                    assert reply.get("ok"), reply
                    return reply["result"]
            raise AssertionError("core exited before replying")

        try:
            imported = call("import_pdfs", paths=[str(ROOT / "corpus/raw/attn.pdf")])[0]
            assert imported["status"] == "imported", imported
            paper_id, version_id = imported["paper_id"], imported["version_id"]
            assert call("import_pdfs", paths=[str(ROOT / "corpus/raw/attn.pdf")])[0]["status"] == "duplicate"
            page = call("list_papers_page", limit=100, sort="title")
            assert page["total"] == 1 and "versions" not in page["items"][0]
            full = call("get_paper", paper_id=paper_id)
            assert full["versions"][0]["pages"] > 1
            assert call("blocks", paper_id=paper_id, version_id=version_id, page=1), "second page must have its own index"
            geometry = dict(paper_id=paper_id, version_id=version_id, page=0)
            blocks = [dict(text="Offline regression marker", bbox=[10, 20, 100, 40])]
            call("set_blocks", **geometry, blocks=blocks)
            first = call("blocks", **geometry)
            call("set_blocks", **geometry, blocks=blocks)
            assert first == call("blocks", **geometry) and first[0]["page"] == 0
            annotation = call("add_annotation", **geometry, quote="marker", rects=[], version_kind="source")
            stored = call("list_annotations", paper_id=paper_id)
            assert stored[0]["id"] == annotation["id"] and stored[0]["version_id"] == version_id
            call("update_paper", paper_id=paper_id, fields=dict(favorite=True))
            assert call("list_papers_page", favorite=True)["total"] == 1
            call("trash_paper", paper_id=paper_id)
            assert call("list_papers_page")["total"] == 0
            assert call("list_papers_page", trashed=True)["total"] == 1
            call("restore_paper", paper_id=paper_id)
            print("PASS: real PDF import/dedup, bounded list, per-page index, stable geometry, annotation version, favorite, trash/restore")
        finally:
            process.stdin.close()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        # The optional Python backend can reopen a Rust-created library.
        from moonlight.desktop import Library
        from moonlight.paging import list_page
        library = Library(directory)
        try:
            page = list_page(library.db, dict(query="regression", sort="title", limit=100))
            assert page["total"] == 1
            assert page["items"][0]["favorite"] and "versions" not in page["items"][0]
            print("PASS: Python compatibility backend reopens Rust index and paginates searches")
        finally:
            library.db.close()


if __name__ == "__main__":
    main()
