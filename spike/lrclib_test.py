"""LRCLIB에 한국 노래 시간 맞춘 가사가 얼마나 있는지 센다."""
import json
import urllib.parse
import urllib.request

SONGS = [  # (가수, 제목) 여러 시대·장르 섞음
    ("아이유", "좋은 날"), ("아이유", "밤편지"), ("BTS", "Dynamite"), ("방탄소년단", "봄날"),
    ("NewJeans", "Hype Boy"), ("BLACKPINK", "뚜두뚜두"), ("IVE", "LOVE DIVE"),
    ("aespa", "Supernova"), ("임영웅", "사랑은 늘 도망가"), ("성시경", "거리에서"),
    ("김광석", "서른 즈음에"), ("이문세", "광화문 연가"), ("빅뱅", "거짓말"),
    ("버즈", "가시"), ("잔나비", "주저하는 연인들을 위해"), ("악뮤", "어떻게 이별까지 사랑하겠어, 널 사랑하는 거지"),
    ("데이식스", "예뻤어"), ("볼빨간사춘기", "우주를 줄게"), ("윤하", "사건의 지평선"),
    ("자우림", "스물다섯, 스물하나"),
]


def search(artist, title):
    q = urllib.parse.urlencode({"track_name": title, "artist_name": artist})
    req = urllib.request.Request(f"https://lrclib.net/api/search?{q}", headers={"User-Agent": "karaoke-spike/0.1"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)


synced = plain = none = 0
for artist, title in SONGS:
    try:
        res = search(artist, title)
    except Exception as e:
        print(f"오류   {artist} - {title}: {e}")
        none += 1
        continue
    s = [x for x in res if x.get("syncedLyrics")]
    if s:
        synced += 1
        first = next(l for l in s[0]["syncedLyrics"].splitlines() if l.strip())
        print(f"시간O  {artist} - {title}  ({len(s)}건) 예: {first[:40]}")
    elif any(x.get("plainLyrics") for x in res):
        plain += 1
        print(f"글자만 {artist} - {title}")
    else:
        none += 1
        print(f"없음   {artist} - {title}")

print(f"\n시간 맞춘 가사 {synced}/{len(SONGS)}, 글자만 {plain}, 없음 {none}")
