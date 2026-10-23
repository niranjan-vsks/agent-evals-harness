import re

_UNITS = {"s": 1, "m": 60, "h": 3600, "d": 86400}
_PART = re.compile(r"(\d+)([smhd])")


def parse_duration(text):
    cleaned = text.strip().lower()
    if not cleaned:
        raise ValueError("empty duration")
    total = 0
    position = 0
    for match in _PART.finditer(cleaned):
        if match.start() != position:
            raise ValueError(f"bad duration: {text!r}")
        total += int(match.group(1)) * _UNITS[match.group(2)]
        position = match.end()
    if position != len(cleaned):
        raise ValueError(f"bad duration: {text!r}")
    return total
