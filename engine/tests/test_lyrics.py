from karaoke_engine import lyrics
from karaoke_engine.lyrics import parse_lrc, split_words, to_lrc


def test_split_words_breaks_on_pause_and_length():
    words = [(0.0, 0.4, " 작은"), (0.5, 0.9, " 숨결"), (1.0, 1.4, " 작은"), (1.5, 1.9, " 소망"),
             (3.0, 3.4, " 기도는"), (3.5, 3.9, " 하늘로"), (4.0, 4.6, " 흘러간다네요오오오오오")]
    assert split_words(words) == [
        {"t": 0.0, "text": "작은 숨결 작은 소망"},  # 1.1초 쉬는 틈에서 끊는다
        {"t": 3.0, "text": "기도는 하늘로"},  # 6 + 11 = 17글자 → 16을 넘기 전에 끊는다
        {"t": 4.0, "text": "흘러간다네요오오오오오"},
    ]


def test_lrc_round_trip():
    text = "[00:24.70] 이 밤 그날의 반딧불을\n[ti:밤편지]\n[01:02.40]\n[00:30.80] 당신의 창 가까이 보낼게요\n"
    lines = parse_lrc(text)
    assert lines == [{"t": 24.7, "text": "이 밤 그날의 반딧불을"}, {"t": 30.8, "text": "당신의 창 가까이 보낼게요"}]
    assert parse_lrc(to_lrc(lines)) == lines


def fake_lrclib(results_by_query):
    def get(params):
        return results_by_query.get(tuple(sorted(params.items())), [])
    return get


def rec(i, track, artist, dur, synced=True):
    return {"id": i, "trackName": track, "artistName": artist, "duration": dur,
            "syncedLyrics": "[00:01.00] 가사" if synced else None, "plainLyrics": "가사"}


def test_search_handles_spacing_and_recommends_close_sure_match(monkeypatch):
    by_artist = [rec(1, "우주를 줄게", "볼빨간사춘기", 217), rec(2, "프리지아", "볼빨간사춘기", 200),
                 rec(3, "우주를 줄게 (Live)", "볼빨간사춘기", 260)]
    monkeypatch.setattr(lyrics, "_get", fake_lrclib({(("q", "볼빨간사춘기"),): by_artist}))
    c = lyrics.search("우주를줄게", "볼빨간사춘기", 218)
    assert [x["id"] for x in c] == [1, 3]  # 띄어쓰기가 달라도 찾고, 제목이 다른 곡은 뺀다
    assert c[0]["recommended"] and not c[1]["recommended"]


def test_search_does_not_auto_pick_unsure_or_far(monkeypatch):
    monkeypatch.setattr(lyrics, "_get", fake_lrclib({(("q", "좋은 날"),): [rec(9, "햇살 좋은 날", "김재중", 241)]}))
    c = lyrics.search("좋은 날", "", 234)
    assert c and not c[0]["recommended"]  # 제목이 다르고 길이도 멀다 → 사용자가 고른다


def test_search_puts_plain_lyrics_last(monkeypatch):
    monkeypatch.setattr(lyrics, "_get", fake_lrclib({(("q", "밤편지"),): [rec(1, "밤편지", "IU", 253, synced=False),
                                                                     rec(2, "밤편지", "IU", 260)]}))
    c = lyrics.search("밤편지", "", 253)
    assert [x["id"] for x in c] == [2, 1] and c[1]["synced"] is False
