from karaoke_engine import lyrics
from karaoke_engine.lyrics import parse_lrc, split_words, to_lrc


def test_split_words_breaks_on_pause_and_length():
    words = [(0.0, 0.4, " 작은"), (0.5, 0.9, " 숨결"), (1.0, 1.4, " 작은"), (1.5, 1.9, " 소망"),
             (3.0, 3.4, " 기도는"), (3.5, 3.9, " 하늘로"), (4.0, 4.6, " 흘러간다네요오오오오오")]
    assert split_words(words) == [
        {"t": 0.0, "text": "작은 숨결 작은 소망", "e": 1.9},  # 1.1초 쉬는 틈에서 끊는다
        {"t": 3.0, "text": "기도는 하늘로", "e": 3.9},  # 6 + 11 = 17글자 → 16을 넘기 전에 끊는다
        {"t": 4.0, "text": "흘러간다네요오오오오오", "e": 4.6},
    ]


def test_lrc_round_trip():
    text = "[00:24.70] 이 밤 그날의 반딧불을\n[ti:밤편지]\n[01:02.40]\n[00:30.80] 당신의 창 가까이 보낼게요\n"
    lines = parse_lrc(text)
    # 가사 없는 시간 줄은 시간 순으로 바로 앞 줄의 끝 (여기서는 마지막 줄이 62.4초에 끝남)
    assert lines == [{"t": 24.7, "text": "이 밤 그날의 반딧불을"}, {"t": 30.8, "text": "당신의 창 가까이 보낼게요", "e": 62.4}]
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


def test_lrc_end_times_round_trip():
    from karaoke_engine.lyrics import parse_lrc, to_lrc
    lines = [{"t": 1.0, "text": "첫 줄", "e": 3.5}, {"t": 10.0, "text": "둘째 줄"}, {"t": 12.0, "text": "끝 줄", "e": 15.0}]
    text = to_lrc(lines)
    assert "[00:03.50]\n" in text and text.rstrip().endswith("[00:15.00]")
    assert parse_lrc(text) == lines
    # 끝이 다음 줄 시작보다 늦으면 적지 않는다 (다음 줄이 곧 끝)
    assert parse_lrc(to_lrc([{"t": 1, "text": "a", "e": 9}, {"t": 5, "text": "b"}])) == [{"t": 1, "text": "a"}, {"t": 5, "text": "b"}]


def test_split_words_keeps_end_time():
    from karaoke_engine.lyrics import split_words
    lines = split_words([(1.0, 1.5, "하늘"), (1.6, 2.2, "높이"), (5.0, 5.8, "날아")])
    assert lines == [{"t": 1.0, "text": "하늘 높이", "e": 2.2}, {"t": 5.0, "text": "날아", "e": 5.8}]
