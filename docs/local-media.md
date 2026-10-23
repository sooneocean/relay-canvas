# 本機素材保存

v0.3 在素材卡／預覽提供「保存本機」。它將已成功執行的圖片或影片複製到目前 `RELAY_DATA_DIR` 的私有 `media/` 目錄；不是另一次生成。保存完成後可從本機預覽或下載，server 重啟後仍可讀取。

## v0.7 匯入與資產 registry

v0.7 新增已驗證的本機檔案匯入。開啟本機畫布後從工具列選取單一 PNG、JPEG、WebP、MP4 或 WebM；匯入直接傳送原始 bytes，檔案最多 64 MiB。server 會檢查精確 MIME、檔頭／格式簽章、種類、長度與工作區配額，成功後建立不可變的本機資產 registry 記錄與實際 asset node。匯入本身不執行 provider、不建立偽造的生成 run；只有使用者明確執行該 asset node 後，才會產生可進入 Gallery、Compare 或 Timeline 的真實本機結果。

每個工作區最多保留 200 個本機資產，所有檔案與保留中的輸出合計最多 512 MiB；相同 SHA-256 內容會去重。canonical 本機參考為 `/api/media/<sha256>`，私有檔案由 registry 保存 MIME、kind、大小與雜湊。asset node 只能引用同一 board 的既有 registry ID，不能同時提供 `assetId` 與 `assetUrl`，也不能由 client 填入本機路徑或私有 metadata。刪除 node 不會刪除 registry、歷史 run 或其檔案；v0.7 不提供手動刪除或自動 GC。

匯入請求帶有穩定的 operationId 與原始 File。若回應在 durable commit 後遺失，重試會沿用相同原始檔案與 operationId，讀回原本的 asset／node，不會重建或覆寫較新的編輯；衝突 metadata 或不同 bytes 會明確失敗。首次 v0.7 workspace 改寫前，server 會保留 byte-exact、0600 的 `workspace.pre-v0.7.json` 與 `.workspace-v0.7` 降版副本及雜湊 marker；它們不得被 symlink、目錄或後續變更取代。降版副本必須連同完整 `media/` 與其他資料目錄內容保存，不能只備份 JSON 或只替換程式碼。

保存識別來源為 run、node、artifact index，server 不接受使用者傳入任意下載網址、檔案路徑或下載標頭。原 artifact URL 保留供同一次工作流的下游模型參考；local URL 僅用於本機顯示。這不會讓本機私有檔案自動變成供應商可讀的公開網址。

## 支援與限制

- PNG、JPEG、WebP、MP4、WebM；檢查 MIME、格式開頭與界線，不宣稱完整 codec 解碼或任意損毀檔案修復。
- 只有 server 自己產生的 Demo SVG 是受限例外，讀取時附加 sandbox CSP；匯入或遠端 SVG、HTML 不允許。
- 每個檔案最多 64 MiB；工作區媒體限額 512 MiB，重複內容以 SHA-256 去重。保存操作串行執行。
- 匯入與保存共用 512 MiB 媒體配額；匯入只接受 1 byte 至 64 MiB 的單一原始檔案內容，拒絕 multipart、chunked、非 identity encoding、任意路徑與外部 URL。實際 asset node 使用 registry 權威資料。
- 遠端只接受當前媒體 allowlist 中的 HTTPS origin、公共 DNS 地址且不跟隨 redirect；不代送 provider 金鑰。伺服器下載有總逾時及串流大小限制。
- 遠端連結到期、缺少下載權限、類型不符或超出限額時，保存會明確失敗。生成成功的狀態與遠端 URL 不變；重試保存不會重送生成請求。
- 資料目錄請一併備份 `workspace.json` 與 `media/`。本版不提供刪除媒體或自動清理孤立檔案的操作。
- 本機資產可明確作為圖片參考送往遠端 image-to-video，但必須先通過 provider preflight、同 board registry 權限、檔案 inode／MIME／SHA 重驗與使用者外部傳輸確認；只有不超過 4 MiB 的圖片才會建立短暫 data URL。這個編碼值只存在於該次 remote request，絕不保存到 run、workspace、Compare、錯誤或 API 回應，也不會送出私有本機 URL、路徑、session token 或 provider key。影片資產不能作圖片參考。

## 本機讀取

`GET /api/media/{sha256}` 必須經 API token 或受限媒體 session cookie 授權；內容 hash 不是授權秘密。瀏覽器在 session bootstrap 取得 HttpOnly、SameSite=Strict、Path=/api/media 的 cookie；普通 API 仍只接受 token header。只有同來源的媒體 GET／HEAD 可用此 cookie，支援影片單段 Range 讀取，拒絕多段或越界 Range。

server 僅綁定 loopback HTTP，因此 cookie 不設 Secure；不適用於公開 HTTP 部署。每次重啟都重新產生 session token，重新載入頁面後即可取得新的媒體 session。網址不含 token，錯誤不回傳實體檔案路徑。

## 升級與降版

v0.3 可讀取 v0.2 workspace；首次改寫前保留原始 `workspace.pre-v0.3.json` 備份。新增 `videos` profile 後，v0.2 不一定能讀取新 workspace，因此降版不能只替換程式碼。

如需降版：停止該工作區 server，先把目前整個資料目錄備份到新位置，再在降版專用目錄使用原始 `workspace.pre-v0.3.json` 作為 `workspace.json`。保留較新的 workspace 與所有 media 檔案，供之後升回 v0.3；不要覆寫唯一的資料副本。本版升級與復原測試使用隔離 fixture，不操作使用者現有作品。
