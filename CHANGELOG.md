# Changelog

## 0.7.0 - 2026-10-23

- OpenAI-compatible／relay 圖片契約支援 `n` 1–4 與 `response_format` `url`／`b64_json`；OpenAI、fal、Replicate 的圖片多輸出依回應順序保留，數量 1–100、格式與總 Base64 6 MiB 限制均在原子驗證後才會保存。
- 新增已驗證的本機 PNG／JPEG／WebP／MP4／WebM 匯入，單檔最多 64 MiB、工作區保留最多 200 個本機資產與 512 MiB 配額；匯入會建立實際 asset node，不會偽造 AI run 或呼叫 provider。
- 本機圖片在明確外部確認後，才可用最多 4 MiB 的一次性傳輸資料作為遠端參考；私有媒體網址不會送往中轉站，傳輸用編碼內容不會保存到 run、Compare 或錯誤資料。重試沿用同一檔案與 operationId，registry／歷史保留本機檔案，不提供 v0.7 刪除或 GC。
- Gallery、Compare 與 Timeline 共用真實資產來源身份；MP4／WebM 可與生成影片混用，沿用既有裁切與排序契約，最後透過已驗證的 FFmpeg 路徑匯出實際 MP4。
- 首次 v0.7 workspace 改寫前保留 byte-exact `workspace.pre-v0.7.json`；降版請使用另外還原的工作區副本。同一 board 的 asset registry 是唯一權威，跨 board 或不完整的本機引用會被拒絕。

本版 provider 與本機媒體契約以 fixture／合約驗證為界，不代表付費 live generation、所有 relay 或任何特定模型已完成驗證。協定參考：[New API plugin usage](https://docs.newapi.ai/en/docs/plugins/usage)。

## 0.6.0 - 2026-10-23

- 新增明確的 `relay` 複合協定：同一個保存的 profile 以固定 `/images/generations` 與 `/videos`、`/videos/{id}` 路徑支援圖片與影片；這是受限的雙協定中轉契約，不是任意 relay 相容性。
- Provider 設定可保存獨立的 image model 與 video model；保存後可用「新增圖→影流程」一次加入相連的圖片／影片節點，保留既有畫布並由使用者自行編輯與執行。
- Compare 可保存並下載選中的圖片或影片精確版本；保存失敗可針對同一 `{runId,nodeId,artifactIndex}` 重試，不會重新生成或改用另一個輸出。
- 選中的已保存影片可交給 Timeline，完成加入、裁切、排列、保存與本機 MP4 匯出；版本、Compare、Timeline 與本機下載維持可追溯的來源身份。
- Provider 輸出在成功提交與下游使用前驗證完整 artifact 陣列、種類與媒體 allowlist；保存工作以 canonical source identity 與 CAS 重驗，避免來源漂移覆寫新版本。

本版仍保留 OpenAI-compatible 為 image-only、Videos JSON 為 video-only；`relay` 只是固定 image/video 路徑的明確組合，不代表任意所有 relay 協定相容性。fixture 與契約文件不等於付費 provider live generation 驗證。

## 0.5.0 - 2026-10-23

- 時間軸新增可搜尋的視覺素材瀏覽器，每頁最多 9 張卡片，可依節點、提示詞、模型、日期及執行版本尋找影片。
- 選取來源可直接預覽、播放、暫停與定位；遠端來源僅在明確預覽時載入，預覽不會保存、加入時間軸或生成。
- 篩選與分頁保留精確選取，失效影片顯示原因；切換、關閉及來源消失會停止並卸載預覽。
- 比較影片後可明確選擇「在時間軸使用」，保留精確版本、節點與輸出序號；支援歷史版本和已刪除節點的成功影片。
- 顯示來源時間、輸出序號與已知時長，失效來源保留原選擇及原因；延遲讀取與更新不會覆蓋手動改選或剪輯草稿。
- 保護時間軸與比較的單一視窗，保存及讀取來源失敗可重試，不會重新生成。
- 修正並行媒體讀取的檔案描述符重複關閉；串流完成、中止或失敗時均由單一流程釋放，避免影響其他請求。

## 0.4.0 - 2026-10-23

- 獨立 revision 的影片時間軸，加入、排列、複製、裁切與連續預覽。
- 橫式／直式實際 H.264／AAC MP4 串接匯出，保存不可變快照並支援取消與中斷狀態。
- 同一畫布兩個已結束生成版本的 A/B 比較，並排設定與產物、協調影片播放。
- Codex MCP 擴充為 17 個工具，完成素材保存到時間軸與匯出的工作流。
- 來源完整性重驗、受控 FFmpeg 子程序、持久／暫存空間限制及升級前備份。

FFmpeg／ffprobe 為另外安裝的系統需求；本版不宣稱 OS codec sandbox 或付費供應商 live generation 驗證。發布依序要求候選版本驗收、同一 commit 的 main CI、標籤 CI，再建立 Release 並讀回公開資產雜湊。

## 0.3.0 - 2026-10-23

- 自訂中轉站模板、設定診斷與明確觸發的模型查詢；金鑰仍由伺服器環境變數讀取。
- 新增明確選用的 Videos JSON 中轉站協定，固定建立與輪詢路徑、受限影片參數和圖片參考。
- 素材可保存至本機私有資料目錄，提供保存狀態、預覽與下載；保留原始生成 URL 作為下游參考。
- 保存有類型、大小、來源與工作區限額檢查；失敗可重試保存，不會重新生成。
- 本機媒體使用受限 session cookie 或 API token 讀取，支援影片單段 Range；升級前保存原始工作區備份。

Videos JSON 是中轉站相容契約，並非已停用的 OpenAI Videos/Sora 官方服務可用性宣告。測試使用 Demo 與 protocol fixtures，不使用付費生成額度。

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
