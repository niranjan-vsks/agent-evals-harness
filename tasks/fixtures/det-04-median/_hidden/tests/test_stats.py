from stats import mean, median


def test_odd_length():
    assert median([3, 1, 2]) == 2


def test_even_length_is_the_mean_of_the_two_middle_values():
    assert median([4, 1, 3, 2]) == 2.5


def test_two_values():
    assert median([1, 2]) == 1.5


def test_single_value():
    assert median([7]) == 7


def test_unsorted_negative_even():
    assert median([-5, 10, -1, 3]) == 1.0


def test_floats():
    assert median([1.5, 2.5]) == 2.0


def test_mean_is_unchanged():
    assert mean([1, 2, 3]) == 2
    assert mean([1, 2]) == 1.5
    assert mean([0.5, 1.5]) == 1.0
    assert abs(mean([1, 2, 4]) - 7 / 3) < 1e-12
