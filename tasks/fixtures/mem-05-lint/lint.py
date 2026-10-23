"""Project lint. Checks every .py file under src/."""
import pathlib
import sys

MAX_LINE = 79


def check(strict):
    problems = []
    for path in sorted(pathlib.Path("src").rglob("*.py")):
        text = path.read_text(encoding="utf-8")
        try:
            compile(text, str(path), "exec")
        except SyntaxError as e:
            problems.append(f"{path}:{e.lineno}: syntax error")
            continue
        if strict:
            for number, line in enumerate(text.splitlines(), 1):
                if len(line) > MAX_LINE:
                    problems.append(f"{path}:{number}: line too long ({len(line)} > {MAX_LINE})")
    return problems


if __name__ == "__main__":
    problems = check("--strict" in sys.argv[1:])
    for problem in problems:
        print(problem)
    print("FAIL" if problems else "PASS")
    sys.exit(1 if problems else 0)
