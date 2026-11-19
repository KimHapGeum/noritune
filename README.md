# Noritune

내 노래 파일이나 유튜브 영상을 반주로 만들어 부르는 Windows PC 노래방 프로그램.

- 화면: Tauri 2 + React + TypeScript (`app/`)
- 처리기: Python 3.12 (`engine/`): 반주 분리, 유튜브 받기, 가사 찾기·자동 생성
- 기획서: `PRD.md`, 배포 순서: `RELEASE.md`

## 오픈 소스 라이선스

이 프로그램은 아래 오픈 소스를 씁니다. 전문은 `app/src/licenses/`에 있고, 앱의 설정 → 정보와 설치 폴더의 `licenses/`에도 들어갑니다.

### Signalsmith Stretch (키·속도 엔진)

https://github.com/Signalsmith-Audio/signalsmith-stretch

```
MIT License

Copyright (c) 2022 Geraint Luff / Signalsmith Audio Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
