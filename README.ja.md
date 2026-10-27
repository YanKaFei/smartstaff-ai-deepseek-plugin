<p align="center">
  <img src="docs/screenshots/20-saas-account-dashboard.png" alt="SmartStaff AI SaaS アカウントコンソール" width="920" />
</p>

<h1 align="center">SmartStaff AI</h1>

<p align="center">
  <b>DeepSeek 分析レイヤーを備えたマルチテナント飲食店人材 SaaS。</b><br />
  <code>deepseek</code> · <code>restaurant-staffing</code> · <code>multi-tenant</code> · <code>saas</code> · <code>part-time-marketplace</code>
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-124%2F124-9be34b" />
  <img alt="schema" src="https://img.shields.io/badge/schema-v21-8cd6ff" />
  <img alt="status" src="https://img.shields.io/badge/status-test--framework-d9ff57" />
  <img alt="languages" src="https://img.shields.io/badge/languages-EN%20%7C%20ZH%20%7C%20KO%20%7C%20JA-8cd6ff" />
</p>

<p align="center">
  <b>言語:</b> <a href="README.md">EN</a> · <a href="README.zh-CN.md">ZH</a> · <a href="README.ko.md">KO</a> · <a href="README.ja.md">JA</a>
</p>

## これは何？

SmartStaff AI は **テストフレームワーク型の飲食店人材 SaaS** です。

- 組織、店舗、店長、アルバイトを 1 つのアカウント体系で接続;
- 店舗横断のアルバイト空きシフトマーケットと応募/承認フロー;
- 決定論的人員予測エンジン;
- 人数のハード制約を変えずに DeepSeek が計画を説明;
- 初回 DeepSeek API 設定ウィザード付き管理コンソール。

完成した商用製品ではなく、**インストール・検証・拡張できるテストフレームワーク**です。

## 製品モジュール

| モジュール | 機能 |
| --- | --- |
| **SaaS アカウント** | メール登録、認証、ログイン、パスワード再設定、組織、メンバー、ロール、招待。 |
| **組織コンソール** | Owner/Admin がメンバー、ロール、店舗、招待、所有権移転、初回店舗を管理。 |
| **アルバイトマーケット** | 組織内の複数店舗の空きを閲覧し、応募・取り下げ・結果確認。 |
| **店長承認** | 応募者を確認し、承認時に confirmed シフトを作成して需要を反映。 |
| **AI 人員予測** | 決定論的予測 + DeepSeek 説明 + 構造化 JSON 検証。 |
| **DeepSeek 設定** | 初回 API ウィザード、暗号化された書き込み専用 Key、モデル/タイムアウト/予算、実接続テスト。 |
| **Shadow 安全** | AI 設定と応募が shadow/pause ゲートを迂回して実シフトを作成しない。 |

## UI

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/20-saas-account-dashboard.png" alt="SaaS アカウント" /><br /><sub><b>アカウントコンソール</b> — 組織、メンバー、セッション。</sub></td>
    <td width="50%"><img src="docs/screenshots/21-saas-org-console.png" alt="組織コンソール" /><br /><sub><b>組織管理</b> — メンバー、招待、店舗。</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/16-staff-marketplace.png" alt="アルバイト空きシフト" /><br /><sub><b>空きシフトマーケット</b> — 店舗横断の応募。</sub></td>
    <td><img src="docs/screenshots/12-plugin-api-setup.png" alt="DeepSeek 初回設定" /><br /><sub><b>DeepSeek 初回設定</b> — 実際の API 接続テスト。</sub></td>
  </tr>
</table>

## クイックスタート

```bash
git clone https://github.com/YanKaFei/smartstaff-ai-deepseek-plugin.git
cd smartstaff-ai-deepseek-plugin
npm run setup
npm run build
npm run seed
npm start
```

- 管理画面: <http://127.0.0.1:8787/admin/>
- SaaS アカウント: <http://127.0.0.1:8787/admin/account.html>
- 組織コンソール: <http://127.0.0.1:8787/admin/org.html>
- H5: <http://127.0.0.1:8787/app/>

Node.js 24+ 推奨。詳細: [docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md).

## SaaS アカウントフロー

1. メール + 組織名で登録。
2. メール認証（開発 token または設定済みメール事業者）。
3. ログインしてアカウント/組織コンソールへ。
4. `admin` / `manager` / `staff` を招待。
5. 組織内に店舗を作成。
6. Owner が店舗へ入る、または店長に割当。
7. 店長が空きを公開し、アルバイトが応募。

メールは outbox + Resend アダプターで処理します。`RESEND_API_KEY`、`EMAIL_FROM`、検証済み送信ドメインがない場合は `PROVIDER_NOT_CONFIGURED` と表示し、送信成功を主張しません。

## DeepSeek 設定

管理者の初回ログイン時、資格情報が未設定なら API ウィザードが開きます。

- Base URL: `https://api.deepseek.com`
- モデル: `deepseek-flash`, `deepseek-v4-pro`
- Key: AES-256-GCM サーバー暗号化、書き込み専用
- 実 HTTPS テスト: ステータス、JSON、`finish_reason`、モデル、token、レイテンシ
- エラー: `AI_AUTH_FAILED`, `AI_TIMEOUT`, `AI_RESPONSE_INVALID`, `AI_NOT_CONFIGURED`
- AI 失敗/無効化/予算超過時は決定論的予測へフォールバック

## アーキテクチャ

```text
組織 / メンバー / 店舗
        │
        ▼
アルバイト空きシフト ── 応募 ──► 店長承認 ──► confirmed シフト
        │
        ▼
決定論的キャパシティエンジン ── 人数ハード制約
        │
        ▼
統合 AI サービス ──► DeepSeek API ──► JSON + Zod 検証
        │
        ▼
構造化説明 / 店長 UI
```

## テナントとセキュリティ

- 店長は店舗組織の active membership が必要。
- アルバイトルートは active staff membership が必要。
- 空きシフトは所属組織でフィルタ。
- Owner/Admin は招待、停止、所有権移転、店舗作成が可能。
- セッションに UA/IP を保存し、他端末セッションを失効可能。
- アカウント/組織/招待/セッション/AI 変更を監査。
- Shadow または一時停止店舗は承認で実シフトを作成不可。

## テスト

```bash
npm test
```

現在 **124/124** 通過。

既存 109 件の基準線は維持し、アカウント登録/認証/再設定、招待、組織ロール、テナント分離、所有権移転、セッション、メール outbox、空きシフトのテストを追加しています。

証拠: [docs/r8-evidence/test-output-r8.txt](docs/r8-evidence/test-output-r8.txt)

## 現在の制限

- **実メール Provider 未設定**: 本番の認証/招待/再設定配信はブロック。開発 token は利用可能。
- 既存電話番号デモアカウントのメール統合が必要。移行スクリプトはあるが実店舗未実行。
- 料金プラン/請求は未実装。`plan` はデータフィールドのみ。
- 本番 PostgreSQL/KMS/複数インスタンス/監視は今後。
- 実店舗パイロットデータと店長フィードバックは待機中。

## DeepSeek / 検索タグ

`deepseek` · `deepseek-api` · `deepseek-plugin` · `ai-plugin` · `restaurant-staffing` · `workforce-management` · `multi-tenant-saas` · `part-time-marketplace` · `shift-scheduling` · `nodejs` · `typescript` · `vue3` · `multilingual`

## ロードマップ

- 実際のトランザクションメール事業者と SPF/DKIM 検証。
- 旧電話番号アカウントとメールアカウントの統合。
- Owner 初回店舗設定ウィザードの完成。
- メンバー削除後のデータ保持ポリシー。
- 料金プランと請求。
- 本番デプロイ強化と実店舗パイロット。

## ライセンス

ライセンス未定。評価と拡張のためのテストフレームワークとして公開されています。
