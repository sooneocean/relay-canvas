# Changelog

## 0.2.0 - 2026-10-23

- 創作首頁、新建入口、圖片／影片快速建立與可搜尋專案卡。
- 中性深灰畫布、浮動工具列、可收合的節點設定與輔助面板。
- 真實生成素材庫、圖片／影片篩選、影片預覽與返回來源節點。
- 共用導航保存保護，避免失敗或並行編輯造成草稿遺失。
- 修正 React Flow 重掛載導致重新初始化，以及 Chromium 影片縮圖擷取全黑的問題。
- 39 項測試與擴充瀏覽器／MCP smoke；供應商及後端協定維持 v0.1。

## 0.1.0 - 2026-10-23

首個公開版本：

- 本機優先的 React Flow 圖片／影片創作畫布與 starter board。
- Demo adapter 提供離線 SVG 圖片與測試影片，不使用 AI 額度。
- OpenAI-compatible、fal queue、Replicate adapter contract 與 provider 設定邊界。
- DAG、revision CAS、執行歷史、取消與中斷狀態保存。
- Token／Origin／Host 邊界、HTTPS provider allowlist、媒體來源限制與秘密隔離。
- stdio MCP 控制面：列出、讀取、建立、原子修改、驗證、執行與查詢畫布。
- CI、smoke 與已建置的 tar.gz 發布包。

付費 provider 的 live generation 未在本版本宣稱已驗證；請以 [研究紀錄](docs/research.md) 為準。
