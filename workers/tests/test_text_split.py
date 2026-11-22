from text_split import split_sentences as split


def test_basic_cjk():
    assert split("哼,你終於來了喔?我才、才沒有在等你呢。好啦,今天要做什麼?") == [
        "哼,你終於來了喔?",
        "我才、才沒有在等你呢。",
        "好啦,今天要做什麼?",
    ]


def test_short_leading_piece_is_merged_forward():
    assert split("哼!你是笨蛋嗎?這種事情也要問我?") == ["哼!你是笨蛋嗎?", "這種事情也要問我?"]


def test_ellipsis_and_repeated_punct_stay_attached():
    assert split("嗯……讓我想一下。") == ["嗯……讓我想一下。"]
    assert split("真的假的?!太好了!!!", min_chars=1) == ["真的假的?!", "太好了!!!"]


def test_english_period_rules():
    assert split("Hello world. This is a test! Is it 3.5 ok?") == ["Hello world.", "This is a test!", "Is it 3.5 ok?"]


def test_closing_quote_stays_with_sentence():
    out = split("「你好嗎?」她說。再見,下次見。", min_chars=1)
    assert out[0] == "「你好嗎?」"


def test_newlines_split_and_blank_lines_dropped():
    assert split("第一行第一行\n\n第二行第二行\n") == ["第一行第一行", "第二行第二行"]


def test_punctuation_only_gives_nothing():
    assert split("。。。") == []
    assert split("   ") == []


def test_trailing_short_piece_merges_back():
    assert split("今天天氣很好。嗯!") == ["今天天氣很好。嗯!"]


def test_long_sentence_is_cut_at_soft_breaks():
    text = "這是一個很長的句子," * 12  # 108 chars, no terminator
    parts = split(text, max_chars=40)
    assert len(parts) >= 3
    assert all(len(p) <= 40 for p in parts)
    assert "".join(parts) == text


def test_no_characters_lost():
    text = "哼,你終於來了喔?我才、才沒有在等你呢。\nbaka! うるさい!這個 boss 的第二階段會放 AOE,先往左邊跑。"
    expected = text.replace(" ", "").replace("\n", "")
    for kw in ({}, {"min_chars": 1}, {"min_chars": 8, "max_chars": 20}):
        assert "".join(split(text, **kw)).replace(" ", "") == expected


def test_long_piece_without_commas_is_cut_at_a_space():
    text = ("I really think that we should probably go ahead and try the brand new restaurants "
            "which opened downtown yesterday evening")
    out = split(text, max_chars=80)
    assert out == ["I really think that we should probably go ahead and try the brand new",
                   "restaurants which opened downtown yesterday evening"]
    assert " ".join(out) == text


def test_long_number_is_not_said_in_two_halves():
    number = "1234567890" * 6
    out = split(f"The total is {number} and 1234567890 more", max_chars=80)
    assert any(number in piece for piece in out)
