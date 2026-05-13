# 실시간 통역 PWA

OpenAI의 `gpt-realtime-translate` API를 사용한 **양방향 실시간 음성 통역** PWA입니다.
스마트폰 한 대로 마주 앉아 서로 다른 언어로 대화할 수 있습니다.

## 동작 방식

- **마이크 1개**만 사용 (피드백 루프 방지)
- **세션 2개**를 미리 열어두고 (한→상대 / 상대→한)
- 누르고 있는 PTT 버튼 쪽 세션으로만 오디오 전송
- 입력 언어는 **자동 감지**, 출력 언어만 사용자가 지정 (13개 지원)
- 백엔드는 OpenAI API 키로 단기 `client_secret`만 발급 → 키는 절대 브라우저로 안 나감

## 지원 출력 언어

한국어, 영어, 일본어, 중국어, 스페인어, 프랑스어, 독일어, 이탈리아어, 포르투갈어, 러시아어, 힌디어, 인도네시아어, 베트남어

## 폴더 구조

```
.
├── api/
│   └── session.js          # Vercel 서버리스: client_secret 발급
├── icons/
│   └── icon.svg            # PNG는 직접 추출 필요 (아래 안내)
├── app.js                  # WebRTC + PTT 로직
├── index.html
├── style.css
├── manifest.webmanifest    # PWA 설치 메타
├── service-worker.js       # 셸 캐시
├── vercel.json
├── package.json
└── .env.example
```

## 사전 준비

1. **OpenAI API 키**: https://platform.openai.com/api-keys 에서 발급
2. **Node.js 18+**
3. **Vercel CLI** (선택): `npm i -g vercel`

## 로컬 실행

```powershell
# 1) 환경변수 설정
copy .env.example .env.local
# .env.local 파일을 열어 OPENAI_API_KEY 값 입력

# 2) Vercel CLI로 로컬 실행 (서버리스 함수까지 함께 돌아감)
npx vercel dev
```

브라우저에서 `http://localhost:3000` 열기.
**마이크 권한은 HTTPS 또는 localhost에서만 작동합니다.**

### 폰에서 테스트하려면?

같은 와이파이의 폰에서 `http://[PC의 IP]:3000` 으로 접속할 수도 있지만, 마이크 권한 때문에 HTTPS가 필요합니다. 가장 쉬운 방법은 **그냥 Vercel에 배포해서 도메인으로 접속**하는 것.

## Vercel 배포

### 방법 A: 깃허브 연동 (권장)

1. 이 폴더를 GitHub repo로 push
2. https://vercel.com/new 에서 repo 선택
3. **Environment Variables**에 `OPENAI_API_KEY` 추가 (Production/Preview/Development 모두 체크)
4. Deploy 클릭

### 방법 B: CLI 직접 배포

```powershell
npx vercel              # 첫 배포 (프로젝트 생성)
npx vercel env add OPENAI_API_KEY production
npx vercel --prod       # 프로덕션 배포
```

## PWA 설치

배포된 URL을 폰 Safari/Chrome에서 열고 **"홈 화면에 추가"** 하면 앱처럼 설치됩니다.

### 아이콘 PNG 만들기

`icons/icon.svg`를 192x192, 512x512 PNG로 변환해서 같은 폴더에 저장:

```powershell
# ImageMagick 사용 시
magick icons/icon.svg -resize 192x192 icons/icon-192.png
magick icons/icon.svg -resize 512x512 icons/icon-512.png
```

온라인 변환 도구(예: https://cloudconvert.com/svg-to-png )도 OK.

## 사용법

1. 첫 방문 시 화면을 한 번 탭 → 마이크 권한 허용
2. 양쪽 상단의 언어 칩으로 내 언어와 상대 언어 설정
3. **파란 버튼(아래)** 을 누르고 있는 동안 내가 말하기 → 상대 쪽 화면에 통역 자막 + 음성
4. **분홍 버튼(위)** 을 누르고 있는 동안 상대가 말하기 → 내 쪽 화면에 통역 자막 + 음성

## 비용

- gpt-realtime-translate: **$0.034/분** (약 47원/분)
- 30분 대화 ≈ $1
- 세션이 2개 열려도 **실제 오디오가 흐르는 시간만 과금**되므로 PTT 방식에선 부담이 적음

## 알려진 제약

- 출력 언어로 이미 말한 음성은 통역되지 않을 수 있음 (예: 영어 출력 세션에 영어 입력)
- 고유명사·전문용어는 그대로 통역 (커스텀 용어집 미지원)
- 통역 음성은 화자의 톤/피치를 모사하지만 정확한 음성 선택 불가

## 라이선스

개인 프로젝트, 자유 사용.
