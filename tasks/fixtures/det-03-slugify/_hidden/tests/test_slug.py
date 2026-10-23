from slug import slugify


def test_basic_phrase():
    assert slugify("Hello, World!") == "hello-world"


def test_runs_of_spaces_collapse_and_edges_are_trimmed():
    assert slugify("  multiple   spaces  ") == "multiple-spaces"


def test_runs_of_hyphens_collapse():
    assert slugify("Already--a---slug") == "already-a-slug"
    assert slugify("---a---") == "a"


def test_apostrophes_and_punctuation_are_separators():
    assert slugify("C'est la vie") == "c-est-la-vie"


def test_accented_letters_lose_their_accents():
    assert slugify("Caf\u00e9 Cr\u00e8me") == "cafe-creme"
    assert slugify("\u00dcn\u00efc\u00f6d\u00e9") == "unicode"


def test_digits_are_kept_and_underscores_are_separators():
    assert slugify("100% pure_python 3.14") == "100-pure-python-3-14"


def test_nothing_left_gives_the_empty_string():
    assert slugify("") == ""
    assert slugify("!!!") == ""
    assert slugify("  - _ ") == ""


def test_the_result_is_stable_when_slugified_again():
    once = slugify("Some Title: Part 2 (draft)")
    assert once == "some-title-part-2-draft"
    assert slugify(once) == once
