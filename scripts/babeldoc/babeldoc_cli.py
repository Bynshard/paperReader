"""Entry point used by the bundled BabelDOC launcher (Windows portable build)."""
import multiprocessing
import os
import sys

from babeldoc.main import cli

if __name__ == "__main__":
    sys.argv[0] = "babeldoc"
    # Match the official portable layout: worker processes use pythonw.exe so
    # they never flash a console window behind the desktop app.
    pythonw = os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime", "pythonw.exe")
    if os.path.exists(pythonw):
        try:
            multiprocessing.set_executable(pythonw)
        except Exception:  # pragma: no cover - best effort on non-Windows layouts
            pass
    code = cli()
    sys.exit(code if isinstance(code, int) else 0)
