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
| `save_artifact` | 明確保存指定成功素材，不重新生成 |
| `get_artifact_info` | 取得已保存本機影片的格式與時長 |
| `read_timeline` | 讀取畫布的獨立時間軸與 revision |
| `update_timeline` | 以 expectedRevision 保存來源、順序與入出點 |
| `export_timeline` | 以 operationId 匯出實際 MP4 |
| `get_export` | 讀取匯出快照、狀態與本機產物 |
| `cancel_export` | 取消本機匯出，不修改原素材 |
| `compare_runs` | 唯讀比較同一畫布兩個已結束 run |

`run_board` 使用新的 `operationId` 表示一次有意義的點擊；重試同一 HTTP 請求才重用相同 id。遠端 run 需要 `confirmExternal=true`，且 server 必須啟用遠端。MCP 不提供任意 shell、檔案、URL 抓取或秘密設定工具。

素材保存使用 `{runId,nodeId,artifactIndex}`（0..99 整數），先明確保存，再讀取影片資訊與設定時間軸。匯出使用已保存的時間軸快照；網路結果未知時重用原 operationId，避免重複處理。完整旅程與限制見 [影片編輯](editing.md)。
