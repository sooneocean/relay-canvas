# 影片時間軸與生成版本比較

從同一畫布生成多個版本後，可以先比較結果，再將選中的成功影片加入時間軸，裁切並串接成可下載 MP4。這些操作不會再次呼叫 AI 生成。

## 環境與素材

影片資訊與匯出使用系統 FFmpeg／ffprobe，支援 macOS 和 Linux，最低 major 6，需含 libx264 和 AAC encoder。使用維持安全更新的系統套件；發行包不包含這些第三方二進位。Ubuntu 可安裝 `ffmpeg` 套件；macOS 請使用已安裝的套件管理方式。工具缺少或不相容時，編輯器會顯示無法處理影片的狀態，畫布與比較仍可使用。

時間軸只接受同一畫布中已成功生成並保存本機的 MP4／WebM。遠端連結須先明確保存，或選擇「保存並加入」；過期連結需供應商提供可讀來源。FFmpeg 不下載遠端網址。保存與加入不會重新生成，來源檔案不會被修改。

## 編輯與匯出

1. 開啟畫布的時間軸，從成功影片選擇來源並加入。
2. 調整片段順序、複製或移除；指定每段來源入點與出點。播放或拖動播放頭檢查剪接。
3. 選擇橫式 1280×720 或直式 720×1280。輸出為 24fps，以黑邊保留來源比例。
4. 保存時間軸；它有獨立 revision，不會更改畫布生成設定。保存失敗或有新編輯時，草稿保留；衝突時先處理版本，再繼續。
5. 匯出使用已保存時間軸的快照。匯出期間可繼續編輯，這些新編輯不會改變進行中的匯出。
6. 完成後在本機預覽或下載 MP4。有聲來源保留首個音訊軌，無聲片段補靜音。取消或失敗不產生可用的部分結果；重試是一次明確的新匯出。

每張時間軸最多 12 段、每段裁切最多 60 秒、總長最多 180 秒。單檔輸出最多 64 MiB；已有媒體與輸出合計持久保存限額 512 MiB。可用空間不足 64 MiB 時，匯出預算會相應縮小，超出預算明確失敗。全工作區同時一個匯出、最多 100 筆匯出紀錄；暫存檔另有 192 MiB 界線。匯出中斷不會自動重跑，重啟後標為 interrupted。

輸出仍透過私有本機媒體授權讀取；下載連結不是公開分享網址，也不能直接作為供應商可讀的公開參考素材。來源與輸出都需一併備份。

## A/B 比較

選擇同一畫布兩個已結束執行版本，再選節點，並排看完整提示詞、模型、provider、參數、狀態和對應產物。兩側影片可一起播放、暫停與定位，長度不同時各自限制在來源範圍。缺少節點或產物會明確顯示，不會代換成另一個版本。

比較是唯讀操作。尚在執行的 run 不可進入比較；新增本機保存資訊不會改變 canonical 生成比較內容。畫面可優先使用目前該版本已保存的本機檔案，因此來源網址過期後仍可預覽。

## Codex 與 API

MCP 的 `save_artifact`、`get_artifact_info` 使用 `{runId,nodeId,artifactIndex}`；index 為 0..99 整數。取得來源後以 `read_timeline` 讀取 revision，`update_timeline` 只傳 clip identity／來源 identity／入出點與 format，再以 `export_timeline` 提交。未知的提交結果重用同一 operationId 查回原匯出；不要換 id 盲目重送。`get_export`／`cancel_export` 使用 exportId；`compare_runs` 使用 boardId、left 和 right runId。

所有新 API 維持 session token／exact Origin／Host 邊界：timeline GET／PUT 位於 `/api/boards/:id/timeline`，export POST 位於 `/api/boards/:id/exports`，狀態／取消為 `/api/exports/:id` 與 `/api/exports/:id/cancel`。比較為 `/api/boards/:id/compare?left=...&right=...`，來源資訊為 `/api/runs/:runId/artifacts/:nodeId/:index/info`。呼叫端不能傳入任意檔案路徑、下載網址、FFmpeg 參數或 credential。

## 升級與限制

首次 v0.4 改寫前保留 byte-identical `workspace.pre-v0.4.json`。升級前仍需停止舊服務並備份完整資料目錄。降版請在另一份資料副本恢復升級前 workspace，保留新版資料與 media；只替換程式碼無法復原資料。

FFmpeg 會解析不可信媒體；來源雜湊、固定 demux／protocol、私有檔案與受控子程序能限制應用層行為，並非 OS codec sandbox 或無漏洞保證。此版驗證使用可重現本機影片 fixtures 和 Demo，不代表付費中轉站的真實生成已通過驗證。
