# Relay Canvas

Relay Canvas 是一個本機優先的圖片與影片創作畫布。啟動後從創作首頁開啟專案或建立圖片／影片畫布：編輯提示詞、連接圖片與影片節點、保存畫布，並在瀏覽器中看到 Demo 產物。Demo 不呼叫外部 AI，也不會消耗供應商額度。

## 快速開始

需求：Node.js 22.12 以上與 npm。影片時間軸資訊與 MP4 匯出另需 macOS／Linux 上維持安全更新的 FFmpeg／ffprobe 6 以上，並支援 libx264／AAC；未安裝時仍可使用畫布生成與版本比較。

```bash
npm ci
npm run build
npm start
```

開啟 <http://127.0.0.1:4310>。開發模式可使用 `npm run dev`，同樣只綁定 loopback。資料預設寫入目前工作目錄的 `.relay-canvas/`，可用 `RELAY_DATA_DIR=/path/to/data` 指定其他資料目錄。

### 使用 GitHub Release 發行包

下載並解壓縮 `relay-canvas-0.6.0.tar.gz` 後，在解壓縮目錄執行：

```bash
npm ci --omit=dev
npm start
```

發行包已包含建置好的 UI 與 server，不需要再次 build。SHA-256 檔可用來檢查下載內容；完整原始碼與開發指令請使用 repository。

## 遠端供應商

遠端生成預設關閉。若要啟用，請在伺服器環境或 `.env` 設定 `RELAY_ENABLE_REMOTE=true`、允許的 exact HTTPS origin，以及 `RELAY_KEY_OPENAI`、`RELAY_KEY_FAL` 或 `RELAY_KEY_REPLICATE` 等 `RELAY_KEY_*` 環境變數。金鑰只由伺服器讀取，不會進入瀏覽器、畫布 JSON、MCP 結果或 log；任何可能產生費用的執行都需要明確確認。

請先閱讀 [供應商與協定](docs/providers.md)。自訂 model 代表使用者提供的 profile；本專案只保證 adapter contract 與 fixture 測試，沒有宣稱任何付費 provider live smoke 已完成。

## 主要能力

- 創作首頁、可搜尋專案卡與圖片／影片快速建立。
- 成功執行素材庫，支援篩選、預覽、返回來源節點及本機保存／下載。
- 影片時間軸：排列／複製／裁切成功影片，連續預覽，匯出橫式或直式 H.264／AAC MP4。
- 生成版本 A/B 比較：並排提示詞、模型、參數與產物，同步影片播放與定位，可保存／下載精確輸出並帶入時間軸。
- 自訂中轉站模板、設定診斷與模型查詢；同一 Image + Video JSON profile 可建立連接好的圖→影流程，使用固定、受限的 API 契約。
- 中性深灰 React Flow 畫布與浮動工具列：prompt、image、video、asset 與 note 節點。
- DAG 驗證、revision optimistic concurrency、原子本機保存與執行歷史。
- 內建 Demo 圖片與影片，適合離線試用與自動化驗證。
- JSON 畫布匯入／匯出；匯入只接受單一 board，不會帶入 provider 或秘密。
- Codex 可透過 stdio MCP 讀取、修改、驗證與執行畫布。

## 架構與資料

Vite + React + TypeScript 提供 UI；Node 22 + Express 提供 loopback API；共享型別與 schema 定義 UI、HTTP 與 MCP 共用的資料邊界。API 以 session token、exact Host／Origin 與 revision 檢查保護 mutation。每個 run 保存 board 與 provider snapshot；重啟後未完成的 run 會標示 `interrupted`，不會自動重送可能計費的 POST。

更多設計與限制見 [產品說明](docs/product.md) 與 [Implementation contract](docs/implementation-contract.md)。

## Codex MCP

先啟動 Relay Canvas，再把下列絕對路徑換成實際位置，使用 Codex CLI 註冊 stdio MCP：

```bash
codex mcp add relay-canvas \
  --env RELAY_DATA_DIR=/absolute/path/to/relay-canvas/.relay-canvas \
  -- node /absolute/path/to/relay-canvas/build/server/mcp.js
codex mcp list --json
```

重新開啟 Codex 對話後，請先讓 agent 呼叫 `list_boards` 確認連線。17 個工具涵蓋畫布、生成、素材保存、時間軸、匯出與版本比較。`RELAY_DATA_DIR` 必須和 server 使用的資料目錄相同；MCP 透過本機 session 檔連接已啟動的 server，不提供任意 shell、檔案或網頁抓取工具。詳見 [Codex 指南](docs/codex.md) 與 [影片編輯](docs/editing.md)。

## 驗證與封裝

```bash
npm run check
npm test
npm run test:release
npm run build
npx playwright install --with-deps chromium
npm run smoke
npm run package:release
npm run smoke:package
```

封裝腳本會以明確白名單產生 `release/relay-canvas-0.6.0.tar.gz` 與 SHA-256 檔，排除 `.relay-canvas`、`.env`、secrets 與 `node_modules`。CI 與發布邊界請看 [CHANGELOG](CHANGELOG.md) 及 [研究紀錄](docs/research.md)。

## Roadmap

- v0.3 已加入本機素材保存與中轉站設定；v0.4 支援時間軸、影片串接與版本比較。
- 後續優化：鏡頭／角色資產、圖生圖、局部重繪、批次流程、預算上限、遠端取消與恢復查詢。
- v1.0：工作區、多使用者權限與稽核、worker／queue、雲端部署、團隊協作與計費界線。

與 LibTV 競爭及一千輪改進是持續目標；每輪須有實質變更與驗證，不以測試次數充數。詳見 [競品證據與進度](docs/competitive-progress.md)。

## License

MIT，詳見 [LICENSE](LICENSE)。
