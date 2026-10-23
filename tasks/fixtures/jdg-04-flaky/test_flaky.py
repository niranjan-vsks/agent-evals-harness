import random

POOL = list(range(1, 21))


def pick_winners(pool, k):
    return random.sample(pool, k)


def test_winners_include_a_small_number():
    winners = pick_winners(POOL, 3)
    assert any(n <= 5 for n in winners)
