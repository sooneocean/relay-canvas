# Codex MCP 指南

先在本機建立並啟動 Relay Canvas server：

```bash
npm ci
npm run build
npm start
```

MCP 入口是建置後的絕對路徑 `node /absolute/path/to/relay-canvas/build/server/mcp.js`，使用 stdio。若資料不在目前工作目錄，可在 MCP server 的環境指定 `RELAY_DATA_DIR=/absolute/path/to/.relay-canvas`。MCP 會讀取 server 建立的本機 session 檔並以 exact origin／token 連接；必須實際啟動 server 才能 connect。

將路徑替換後註冊到 Codex（發行包使用相同的 `build/server/mcp.js` 入口）：

```bash
codex mcp add relay-canvas \
  --env RELAY_DATA_DIR=/absolute/path/to/relay-canvas/.relay-canvas \
  -- node /absolute/path/to/relay-canvas/build/server/mcp.js
codex mcp list --json
```

新開 Codex 對話，先要求 `list_boards`，成功後再要求修改或執行畫布。`RELAY_DATA_DIR` 必須指向 server 使用的資料目錄。範例指令已依本機 `codex mcp add --help` 核對；本專案測試透過 MCP SDK 建立真實 stdio 連線，不會自動修改使用者的 Codex 全域設定。

## 工具

| 工具 | 用途 |
| --- | --- |
| `list_boards` | 列出 board 摘要 |
| `read_board` | 讀取指定 board |
| `create_board` | 建立空 board |
| `apply_operations` | 以 expected revision 原子套用節點／連線操作 |
| `validate_board` | 檢查 DAG、provider 與執行順序 |
| `run_board` | 執行 Demo 或已確認的遠端 run |
| `get_run` | 讀取 run 狀態與結果 |
| `cancel_run` | 停止本機 polling |
| `list_providers` | 列出 provider 設定，不回傳金鑰 |

`run_board` 使用新的 `operationId` 表示一次有意義的點擊；重試同一 HTTP 請求才重用相同 id。遠端 run 需要 `confirmExternal=true`，且 server 必須啟用遠端。MCP 不提供任意 shell、檔案、URL 抓取或秘密設定工具。
