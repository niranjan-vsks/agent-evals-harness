import subprocess
import sys


def test_prints_the_greeting_and_exits_cleanly():
    out = subprocess.run([sys.executable, "hello.py"], capture_output=True, text=True, timeout=20)
    assert out.returncode == 0
    assert out.stdout == "hello, evals\n"
