<p align="center">
  <img src="docs/screenshots/20-saas-account-dashboard.png" alt="SmartStaff AI SaaS 계정 콘솔" width="920" />
</p>

<h1 align="center">SmartStaff AI</h1>

<p align="center">
  <b>DeepSeek 분석 레이어를 갖춘 멀티테넌트 레스토랑 인력 SaaS.</b><br />
  <code>deepseek</code> · <code>restaurant-staffing</code> · <code>multi-tenant</code> · <code>saas</code> · <code>part-time-marketplace</code>
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-124%2F124-9be34b" />
  <img alt="schema" src="https://img.shields.io/badge/schema-v21-8cd6ff" />
  <img alt="status" src="https://img.shields.io/badge/status-test--framework-d9ff57" />
  <img alt="languages" src="https://img.shields.io/badge/languages-EN%20%7C%20ZH%20%7C%20KO%20%7C%20JA-8cd6ff" />
</p>

<p align="center">
  <b>언어:</b> <a href="README.md">EN</a> · <a href="README.zh-CN.md">ZH</a> · <a href="README.ko.md">KO</a> · <a href="README.ja.md">JA</a>
</p>

## 무엇인가요?

SmartStaff AI는 **테스트 프레임워크 레스토랑 인력 SaaS**입니다.

- 조직, 매장, 매니저, 아르바이트를 하나의 계정 체계로 연결;
- 매장 간 아르바이트 공석 마켓과 지원/승인 워크플로;
- 결정론적 인력 예측 엔진;
- DeepSeek가 인원수 하드 제약을 바꾸지 않고 계획을 설명;
- 첫 실행 DeepSeek API 설정 마법사가 있는 관리자 콘솔.

완성된 상용 제품이 아니라 **설치·검토·확장 가능한 테스트 프레임워크**입니다.

## 제품 모듈

| 모듈 | 기능 |
| --- | --- |
| **SaaS 계정** | 이메일 가입, 인증, 로그인, 비밀번호 재설정, 조직, 멤버십, 역할, 초대. |
| **조직 콘솔** | Owner/Admin이 멤버, 역할, 매장, 초대, 소유권 이전, 첫 매장을 관리. |
| **아르바이트 마켓** | 조직 내 여러 매장의 공석을 보고 지원·철회·결과 확인. |
| **매니저 승인** | 지원자를 검토하고 승인 시 confirmed 근무 생성 및 공석 수량 반영. |
| **AI 인력 예측** | 결정론적 예측 + DeepSeek 설명 + 구조화 JSON 검증. |
| **DeepSeek 설정** | 첫 API 마법사, 암호화된 쓰기 전용 Key, 모델/시간 초과/예산, 실제 연결 테스트. |
| **Shadow 안전** | AI 설정과 지원이 shadow/pause 게이트를 우회해 실제 근무를 만들지 않음. |

## UI

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/20-saas-account-dashboard.png" alt="SaaS 계정" /><br /><sub><b>계정 콘솔</b> — 조직, 멤버십, 세션.</sub></td>
    <td width="50%"><img src="docs/screenshots/21-saas-org-console.png" alt="조직 콘솔" /><br /><sub><b>조직 관리</b> — 멤버, 초대, 매장.</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/16-staff-marketplace.png" alt="아르바이트 공석" /><br /><sub><b>공석 마켓</b> — 매장 간 지원.</sub></td>
    <td><img src="docs/screenshots/12-plugin-api-setup.png" alt="DeepSeek 첫 설정" /><br /><sub><b>DeepSeek 첫 설정</b> — 실제 API 연결 테스트.</sub></td>
  </tr>
</table>

## 빠른 시작

```bash
git clone https://github.com/YanKaFei/smartstaff-ai-deepseek-plugin.git
cd smartstaff-ai-deepseek-plugin
npm run setup
npm run build
npm run seed
npm start
```

- 관리자: <http://127.0.0.1:8787/admin/>
- SaaS 계정: <http://127.0.0.1:8787/admin/account.html>
- 조직 콘솔: <http://127.0.0.1:8787/admin/org.html>
- H5: <http://127.0.0.1:8787/app/>

Node.js 24+ 권장. 전체 설치 안내: [docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md).

## SaaS 계정 흐름

1. 이메일 + 조직명으로 가입.
2. 이메일 인증 (개발 token 또는 설정된 메일 제공자).
3. 로그인 후 계정/조직 콘솔 진입.
4. `admin` / `manager` / `staff` 초대.
5. 조직 안에 매장 생성.
6. Owner가 매장에 진입하거나 매니저에게 배정.
7. 매니저가 공석을 게시하고 아르바이트가 지원.

메일은 outbox + Resend 어댑터로 처리됩니다. `RESEND_API_KEY`, `EMAIL_FROM`, 검증된 발신 도메인이 없으면 `PROVIDER_NOT_CONFIGURED`로 표시하며 발송 성공을 주장하지 않습니다.

## DeepSeek 설정

관리자 첫 로그인 시 자격 증명이 없으면 API 마법사가 열립니다.

- Base URL: `https://api.deepseek.com`
- 모델: `deepseek-flash`, `deepseek-v4-pro`
- Key: AES-256-GCM 서버 암호화, 쓰기 전용
- 실제 HTTPS 테스트: 상태 코드, JSON, `finish_reason`, 모델, token, 지연
- 오류: `AI_AUTH_FAILED`, `AI_TIMEOUT`, `AI_RESPONSE_INVALID`, `AI_NOT_CONFIGURED`
- AI 실패/비활성화/예산 초과 시 결정론적 예측으로 폴백

## 아키텍처

```text
조직 / 멤버 / 매장
        │
        ▼
아르바이트 공석 마켓 ── 지원 ──► 매니저 승인 ──► confirmed 근무
        │
        ▼
결정론적 수용량 엔진 ── 인원 하드 제약
        │
        ▼
통합 AI 서비스 ──► DeepSeek API ──► JSON + Zod 검증
        │
        ▼
구조화 설명 / 매니저 UI
```

## 테넌트와 보안

- 매니저는 매장 조직의 active membership이 있어야 접근.
- 아르바이트 라우트는 active staff membership 필요.
- 공석 마켓은 직원 조직 기준으로 필터링.
- Owner/Admin은 초대, 정지, 소유권 이전, 매장 생성 가능.
- 세션에 UA/IP 저장, 다른 기기 세션 철회 가능.
- 계정/조직/초대/세션/AI 변경 감사.
- Shadow 또는 일시정지 매장은 승인으로 실제 근무를 만들 수 없음.

## 테스트

```bash
npm test
```

현재 **124/124** 통과.

기존 109개 기준선은 유지되며, 계정 가입/인증/재설정, 초대, 조직 역할, 테넌트 격리, 소유권 이전, 세션, 이메일 outbox, 공석 마켓 테스트가 추가되었습니다.

증거: [docs/r8-evidence/test-output-r8.txt](docs/r8-evidence/test-output-r8.txt)

## 현재 제한

- **실제 메일 Provider 미설정**: 운영 검증/초대/재설정 발송 차단. 개발 token은 동작.
- 기존 전화번호 데모 계정의 이메일 계정 병합 필요. 마이그레이션 스크립트는 있으나 실제 매장에 실행하지 않음.
- 요금제/빌링 미구현. `plan`은 데이터 필드일 뿐.
- 운영 PostgreSQL/KMS/다중 인스턴스/모니터링은 향후.
- 실제 매장 파일럿 데이터와 매니저 피드백은 대기 중.

## DeepSeek / 검색 태그

`deepseek` · `deepseek-api` · `deepseek-plugin` · `ai-plugin` · `restaurant-staffing` · `workforce-management` · `multi-tenant-saas` · `part-time-marketplace` · `shift-scheduling` · `nodejs` · `typescript` · `vue3` · `multilingual`

## 로드맵

- 실제 트랜잭션 메일 제공자와 SPF/DKIM 검증.
- 기존 전화번호 계정과 이메일 계정 병합.
- Owner 첫 매장 설정 마법사 완성.
- 멤버 제거 후 데이터 보존 정책.
- 요금제와 빌링.
- 운영 배포 강화와 실제 매장 파일럿.

## 라이선스

라이선스 미정. 평가와 확장을 위한 테스트 프레임워크로 공개됩니다.
