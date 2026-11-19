import pytest

from karaoke_engine.youtube import classify, clean, guess, video_id


@pytest.mark.parametrize("title,kind", [
    ("[TJ노래방] 우주를줄게 - 볼빨간사춘기 / TJ Karaoke", "karaoke"),
    ("[노래방] 볼빨간사춘기 우주를 줄게 반주 키변경", "karaoke"),
    ("[금영노래방] 밤편지 - 아이유", "karaoke"),
    ("우주를 줄게 피아노 반주 MR", "mr"),
    ("볼빨간사춘기 - 우주를 줄게 (MR)", "mr"),
    ("우주를 줄게 (Inst.) - 볼빨간사춘기", "inst"),
    ("IU - Through the Night Instrumental", "inst"),
    ("볼빨간사춘기(BOL4) - 우주를 줄게 [가사/Lyrics]", "normal"),
    ("MRI 소리 모음", "normal"),  # 낱말 경계: MRI는 MR이 아니다
])
def test_classify(title, kind):
    assert classify(title) == kind


@pytest.mark.parametrize("title,channel,expect", [
    ("[TJ노래방] 우주를줄게 - 볼빨간사춘기 / TJ Karaoke", "TJ노래방 공식 유튜브채널", ("우주를줄게", "볼빨간사춘기")),
    ("볼빨간사춘기(BOL4) - 우주를 줄게 [가사/Lyrics]", "웅키", ("우주를 줄게", "볼빨간사춘기")),
    ("IU(아이유) - 밤편지 (Official MV)", "IU", ("밤편지", "IU")),
    ("우주를 줄게 (Inst.) - 볼빨간사춘기", "x", ("볼빨간사춘기", "우주를 줄게")),  # 순서가 반대인 영상은 사용자가 고친다
    ("밤편지", "IU - Topic", ("밤편지", "IU")),
])
def test_guess(title, channel, expect):
    assert guess(title, channel) == expect


def test_clean_strips_decorations():
    assert clean("[TJ노래방 / 멜로디제거] 우주를줄게 - 볼빨간사춘기 / TJ Karaoke") == "우주를줄게 - 볼빨간사춘기"


@pytest.mark.parametrize("text,vid", [
    ("https://www.youtube.com/watch?v=aE3irDN5yqQ&list=x", "aE3irDN5yqQ"),
    ("https://youtu.be/aE3irDN5yqQ", "aE3irDN5yqQ"),
    ("aE3irDN5yqQ", "aE3irDN5yqQ"),
    ("볼빨간사춘기 우주를 줄게", None),
])
def test_video_id(text, vid):
    assert video_id(text) == vid


def test_pick_mv_prefers_official_and_skips_covers():
    from karaoke_engine.youtube import pick_mv
    results = [
        {"id": "a" * 11, "title": "밤편지 노래방 TJ", "channel": "TJ"},
        {"id": "b" * 11, "title": "아이유 밤편지 피아노 커버", "channel": "someone"},
        {"id": "c" * 11, "title": "밤편지 (Live)", "channel": "IU"},
        {"id": "d" * 11, "title": "[MV] IU(아이유) _ Through the Night(밤편지)", "channel": "1theK (원더케이)"},
        {"id": "e" * 11, "title": "아이유 - 밤편지", "channel": "이지금 [IU Official]"},
        {"id": "f" * 11, "title": "Alive", "channel": "x"},  # live 가 단어 안에 있어도 빼지 않는다
    ]
    assert pick_mv(results, "아이유", "밤편지") == ["d" * 11, "e" * 11, "f" * 11]
