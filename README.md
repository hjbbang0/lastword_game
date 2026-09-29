# 🏹 끝말 헌터

AI 심판과 겨루는 끝말잇기 게임. AI 1:1 대결 + 친구와 실시간 온라인 대결.

## 구조
```
index.html      게임 화면 (단일 파일)
platform.js     AI 호출(/api/judge) + Supabase 실시간 방 어댑터
api/judge.js    Vercel 서버리스 함수 — Anthropic API로 단어 판정 (API 키는 서버에만)
api/config.js   브라우저에 공개 가능한 설정 전달
```

## 배포 (GitHub → Vercel)
1. 이 폴더를 GitHub 저장소에 올립니다.
2. vercel.com → Add New → Project → 저장소 Import (Framework Preset: Other, 빌드 설정 비워 둠)
3. Environment Variables 추가
   - `ANTHROPIC_API_KEY` (필수) — console.anthropic.com 에서 발급
   - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (온라인 대결용, 선택)
4. Deploy. 이후 GitHub에 push할 때마다 자동 재배포됩니다.

## 온라인 대결 (Supabase)
supabase.com에서 무료 프로젝트 생성 → Project Settings → API 에서 URL과 anon public 키 복사.
테이블은 만들 필요 없습니다 (Realtime Presence만 사용). 무료 프로젝트는 일주일간 사용이 없으면 일시정지되니 대시보드에서 다시 켜 주세요.

## 참고
- 환경변수가 없으면 AI 심판 없이 연습 모드(내장 단어장)로 동작합니다.
- `api/judge.js`에 IP당 분당 호출 제한이 있습니다 (`RATE_LIMIT_PER_MIN`, 기본 40).
