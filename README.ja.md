<p align="center">
  <img src="docs/screenshots/12-plugin-api-setup.png" alt="SmartStaff AI DeepSeek プラグイン初回設定ウィザード" width="920" />
</p>

<h1 align="center">SmartStaff AI · DeepSeek プラグイン</h1>

<p align="center">
  <b>初回起動時に DeepSeek API 設定ウィザードが開く、プラグイン型の店舗人材ワークスペース。</b><br />
  <code>deepseek</code> · <code>deepseek-api</code> · <code>deepseek-plugin</code> · <code>ai-plugin</code> · <code>多言語</code>
</p>

<p align="center">
  <img alt="tests" src="https://img.shields.io/badge/tests-105%2F105-9be34b" />
  <img alt="status" src="https://img.shields.io/badge/status-test--framework-d9ff57" />
  <img alt="languages" src="https://img.shields.io/badge/languages-EN%20%7C%20ZH%20%7C%20KO%20%7C%20JA-8cd6ff" />
  <img alt="DeepSeek" src="https://img.shields.io/badge/DeepSeek-api.deepseek.com-4d6bfe" />
</p>

<p align="center">
  <b>言語:</b> <a href="README.md">EN</a> · <a href="README.zh-CN.md">ZH</a> · <a href="README.ko.md">KO</a> · <a href="README.ja.md">JA</a>
</p>

## これは何？

SmartStaff AI は、飲食店の人材計画のための**テスト用フレームワーク・プラグイン**です。決定論的なキャパシティエンジン、DeepSeek による説明レイヤー、洗練された管理ワークスペースを組み合わせています。

管理者が初めてログインしたとき、資格情報が未設定なら **DeepSeek API 設定ウィザード**が自動で開きます。Key を保存して実際の接続をテストすると、業務 AI も同じランタイム設定を使います。

完成した商用製品ではなく、**インストール・検証・拡張できるプラグイン・フレームワーク**です。

## 特徴

- **初回起動で設定**：ログイン後すぐに API ウィザードが開きます。
- **実際の接続テスト**：実際の HTTPS リクエストで、ステータス、JSON、`finish_reason`、モデル、トークン、レイテンシを確認。
- **書き込み専用 Key**：生の Key はブラウザーや通常ログに戻りません。
- **決定論的コア**：DeepSeek は説明と提案のみ。人数やハード制約は決定しません。
- **4 言語**：中国語、英語、韓国語、日本語をワンクリックで切替。
- **Shadow 安全**：AI 設定は実際の招待、シフト、通知、人件費を発生させません。

## UI

<table>
  <tr>
    <td width="50%"><img src="docs/screenshots/12-plugin-api-setup.png" alt="初回設定ウィザード" /><br /><sub><b>初回設定</b> — 未設定ならログイン後に自動で開きます。</sub></td>
    <td width="50%"><img src="docs/r6-evidence/screenshots/r6-ai-settings-no-key.png" alt="AI 設定" /><br /><sub><b>AI 設定</b> — モデル、タイムアウト、予算、資格情報、使用量。</sub></td>
  </tr>
  <tr>
    <td><img src="docs/screenshots/09-admin-overview.png" alt="運用概要" /><br /><sub><b>運用ワークスペース</b> — テーブル、待ち行列、予測、例外。</sub></td>
    <td><img src="docs/screenshots/04-ai-plans.png" alt="AI 分析" /><br /><sub><b>AI 説明</b> — 構造化分析。人数を直接決めません。</sub></td>
  </tr>
</table>

## インストール

```bash
git clone https://github.com/YanKaFei/smartstaff-ai-deepseek-plugin.git
cd smartstaff-ai-deepseek-plugin
npm run setup
npm run build
npm run seed
npm start
```

<http://127.0.0.1:8787/admin/> を開きます。

> `npm run setup` はサーバーとミニプログラムの依存関係をインストールします。Node.js 24+ 推奨。

### 初回起動

1. 管理ワークスペースにログインします。
2. 資格情報が未設定なら **DeepSeek 設定ウィザード**が自動で開きます。
3. モデルを選び、Key を貼り付けて **保存して接続テスト** をクリック。
4. Key がなくても閉じられます。決定論的予測は動作し続けます。

詳細: [docs/PLUGIN-INSTALL.md](docs/PLUGIN-INSTALL.md)

## 設定

| 項目 | 既定値 | 備考 |
| --- | --- | --- |
| プロバイダー | DeepSeek | 初版のみ |
| Base URL | `https://api.deepseek.com` | 公式のみ |
| モデル | `deepseek-flash` | `deepseek-v4-pro` 任意 |
| タイムアウト | 20 秒 | 5–60 秒 |
| AI スイッチ | 有効 | 無効化可能 |
| 店舗の日次予算 | $5 | 推定 |
| プラットフォーム予算 | $80 / 30 日 | 推定 |
| 資格情報 | 未設定 | 書き込み専用、サーバー暗号化 |

リクエスト開始時に設定スナップショットを 1 回解決します。処理中のリクエストは古いスナップショットを使い、次のリクエストから新しい設定を使います。

## アーキテクチャ

```text
店舗データ
   │
   ▼
決定論的キャパシティエンジン ── ハード制約 / 必要人数
   │
   ▼
統合 AI サービス ──► DeepSeek API ──► JSON / Zod 検証
   │                                      │
   ▼                                      ▼
構造化分析                          失敗時フォールバック
   │
   ▼
管理ワークスペース / マネージャー UI
```

- DeepSeek は説明、提案、リスクのみを生成します。
- 人数とマッチングのハード制約は決定論的エンジンが保持します。
- AI 失敗、無効化、予算超過時はマネージャーフローを止めずフォールバックします。

## セキュリティ

- API Key は AES-256-GCM で暗号化（AAD `smartstaff:ai-api-key:v1`）。
- Key はブラウザー `localStorage`、ミニプログラム保存領域、ビルド成果物、通常ログに入りません。
- 管理者専用 API。機密変更には最近のログイン再確認が必要です。
- 資格情報の失効は保存 Key と環境変数フォールバックの両方を遮断します。
- 公式 DeepSeek Base URL のみ許可。任意 URL は拒否します。
- 実際のエラーは `AI_AUTH_FAILED`、`AI_TIMEOUT`、`AI_RESPONSE_INVALID`、`AI_NOT_CONFIGURED` にマッピング。

## テスト

```bash
npm test
```

現在 **105/105** 通過。既存 R5.2 の 95 件はすべて保持し、10 件の AI 設定テストが資格情報ライフサイクル、RBAC、401、タイムアウト、不正 JSON、スキーマ失敗、AI 無効化、予算/使用量、失効を検証します。

実際の API 成功には実際の Key が必要です。Key がない場合は **REAL_API_BLOCKED** と表示し、Mock 接続を成功と主張しません。

## DeepSeek 検索タグ

`deepseek` · `deepseek-api` · `deepseek-plugin` · `deepseek-tools` · `ai-plugin` · `ai-settings` · `llm-plugin` · `openai-compatible` · `restaurant-staffing` · `workforce-management` · `smartstaff` · `multilingual` · `typescript` · `vue3` · `nodejs`

## 将来の可能性

- プラグインマーケットのパッケージ化とワンクリック導入。
- 明示的な許可リストによる DeepSeek 互換プロバイダーの追加。
- 管理 UI へのリアルタイムストリーミング分析。
- 飲食店 POS/待ち行列アダプターとより深い需要シグナル。
- 実店舗での 14 日間 Shadow 評価。
- プロバイダー請求書とのコスト照合。
- ロールベースのチームワークスペースと監査エクスポート。

## プロジェクト状態

**テストフレームワーク / 商用化前。** UI、API 設定、資格情報ライフサイクル、DeepSeek プローブ、決定論的フォールバックは実装・テスト済みです。実店舗データ、実際のマネージャーフィードバック、本番規模のインフラは今後の課題です。

## ライセンス

ライセンス未定。このリポジトリは評価と拡張のためのテストフレームワークとして公開されています。
