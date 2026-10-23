# 本機素材保存

v0.3 在素材卡／預覽提供「保存本機」。它將已成功執行的圖片或影片複製到目前 `RELAY_DATA_DIR` 的私有 `media/` 目錄；不是另一次生成。保存完成後可從本機預覽或下載，server 重啟後仍可讀取。

保存識別來源為 run、node、artifact index，server 不接受使用者傳入任意下載網址、檔案路徑或下載標頭。原 artifact URL 保留供同一次工作流的下游模型參考；local URL 僅用於本機顯示。這不會讓本機私有檔案自動變成供應商可讀的公開網址。

## 支援與限制

- PNG、JPEG、WebP、MP4、WebM；檢查 MIME、格式開頭與界線，不宣稱完整 codec 解碼或任意損毀檔案修復。
- 只有 server 自己產生的 Demo SVG 是受限例外，讀取時附加 sandbox CSP；匯入或遠端 SVG、HTML 不允許。
- 每個檔案最多 64 MiB；工作區媒體限額 512 MiB，重複內容以 SHA-256 去重。保存操作串行執行。
- 遠端只接受當前媒體 allowlist 中的 HTTPS origin、公共 DNS 地址且不跟隨 redirect；不代送 provider 金鑰。伺服器下載有總逾時及串流大小限制。
- 遠端連結到期、缺少下載權限、類型不符或超出限額時，保存會明確失敗。生成成功的狀態與遠端 URL 不變；重試保存不會重送生成請求。
- 資料目錄請一併備份 `workspace.json` 與 `media/`。本版不提供刪除媒體或自動清理孤立檔案的操作。

## 本機讀取

`GET /api/media/{sha256}` 必須經 API token 或受限媒體 session cookie 授權；內容 hash 不是授權秘密。瀏覽器在 session bootstrap 取得 HttpOnly、SameSite=Strict、Path=/api/media 的 cookie；普通 API 仍只接受 token header。只有同來源的媒體 GET／HEAD 可用此 cookie，支援影片單段 Range 讀取，拒絕多段或越界 Range。

server 僅綁定 loopback HTTP，因此 cookie 不設 Secure；不適用於公開 HTTP 部署。每次重啟都重新產生 session token，重新載入頁面後即可取得新的媒體 session。網址不含 token，錯誤不回傳實體檔案路徑。

## 升級與降版

v0.3 可讀取 v0.2 workspace；首次改寫前保留原始 `workspace.pre-v0.3.json` 備份。新增 `videos` profile 後，v0.2 不一定能讀取新 workspace，因此降版不能只替換程式碼。

如需降版：停止該工作區 server，先把目前整個資料目錄備份到新位置，再在降版專用目錄使用原始 `workspace.pre-v0.3.json` 作為 `workspace.json`。保留較新的 workspace 與所有 media 檔案，供之後升回 v0.3；不要覆寫唯一的資料副本。本版升級與復原測試使用隔離 fixture，不操作使用者現有作品。
