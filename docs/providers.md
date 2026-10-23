# Provider 與協定

預設模型僅代表有官方文件的 profile，沒有付費 live 驗證。fal 圖片使用 `fal-ai/flux/schnell`；影片使用 `fal-ai/kling-video/v3/standard/image-to-video`，參考圖欄位是 `start_image_url`。Replicate `minimax/video-01` 使用 `first_frame_image`。UI 選模型時會建議欄位，仍可依中轉站文件手動修改。來源：[fal Kling v3 schema](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api)、[Replicate MiniMax inputs](https://replicate.com/minimax/video-01)。舊 Kling v2.1 已被官方標示 deprecated，因此不作為預設。

模型輸出 CDN 的 exact origin 必須加入 `RELAY_MEDIA_ORIGINS`；例如 Replicate 可能回傳 `https://tjzk.replicate.delivery` 等分流域名，這不等於 `https://replicate.delivery`。未加入時安全拒絕顯示及下載，請依供應商文件設定，不會自動放行所有子網域。遠端 URL 可能過期；v0.3 可在到期前明確選擇保存本機。下載不會代送 provider Authorization，因此需要額外受保護下載的輸出仍不支援。見 [本機素材](local-media.md)。

Relay Canvas 以 adapter 介面接入 provider。每個生成請求都由 server 組合安全的 prompt、model、參數與參考欄位；provider 回應會被正規化為 image 或 video artifact。fixture 測試涵蓋建立、輪詢、成功、錯誤 schema、429／500、timeout 與 abort。下列 live URL 是協定文件來源與預設 origin，不代表本專案已完成付費 live smoke。

## Demo

Demo 不做外連。它產生固定程式生成的 SVG data URL 或本機 `/demo-motion.mp4`，用於離線試用與 smoke；SVG 匯入仍被拒絕，避免把任意 HTML 當媒體。

## OpenAI-compatible / New API

以 `POST {baseUrl}/images/generations` 傳送 Bearer env key、model、prompt、`n: 1` 與受限參數，讀取 `data[].url` 或 `data[].b64_json`。此圖片協定支援 text-to-image，不接受 image input；影片需另選 Videos JSON、fal 或 Replicate 協定。OpenAI 圖片 API 的實際欄位應以 operator 選定服務的文件為準。

## 自訂中轉站設定

1. 在 Providers 選擇模板並新增設定。New API／One API 使用 OpenAI-compatible 圖片協定；協定名稱並不保證所有模型可用。
2. 填入服務商的 HTTPS Base URL（常見為 `https://your-relay.example/v1`）、顯示名稱、圖片／影片模型及 `RELAY_KEY_*` 環境變數名稱。
3. 在 server 的 `.env` 設定實際金鑰，將 API 的 exact origin 加入 `RELAY_PROVIDER_ORIGINS`、輸出 CDN 加入 `RELAY_MEDIA_ORIGINS`，啟用 `RELAY_ENABLE_REMOTE=true`，再重新啟動 server。UI 只填變數名稱，不能把金鑰當作 Base URL 或模型參數。
4. 保存 profile 後查看診斷。已配置金鑰只表示 server 找到該環境變數，並不表示金鑰有效或有額度。診斷不呼叫生成端點。
5. OpenAI-compatible／Videos JSON profile 可明確查詢固定 `GET {base}/models`；Demo 使用內建列表。模型列表只代表供應商回傳的 ID，不推斷圖片／影片能力。fal／Replicate 保留手動填模型。

未保存的修改須先保存才能診斷或查詢；失敗時可修改設定並再次嘗試。模型查詢不會暗中執行生成。實際生成仍需逐次費用確認。

## Videos JSON 中轉站

這是供中轉站實作的明確 JSON 相容契約，並非 OpenAI 官方影片服務可用性宣告。官方文件已標示 OpenAI Videos/Sora API 於 2026-09-24 停用；模板不預填官方 Sora 模型。來源：[官方歷史 Videos 文件](https://developers.openai.com/api/reference/resources/videos/methods/create)。

- 建立：`POST {base}/videos`，Bearer env key，JSON `model`、`prompt`；可選 `seconds` 為字串 `4`、`8`、`12`，`size` 為 `720x1280`、`1280x720`、`1024x1792`、`1792x1024`。其他影片參數會在 POST 前拒絕。
- 圖轉影固定使用 `input_reference: { image_url: 原始上游圖片URL }`；本機授權網址不會送給外部模型。
- 建立回傳 `id` 與 `status`；先保存 remote ID，再查詢 `GET {base}/videos/{id}`。
- `queued`／`in_progress` 繼續輪詢；`completed` 必須回傳頂層 `url` 或 `video_url`，並符合媒體 allowlist；`failed` 或未知狀態停止。
- 不支援只提供需金鑰 `/content` 下載的回應，也不支援任意路徑、腳本或 JSON 映射。供應商必須符合上述契約，否則需其他 adapter。

fixture 測試證明請求與錯誤處理契約，不等同於任何實際中轉站的付費 live 驗證。未知 POST 結果不會重送，以免重複計費。

## fal

預設 queue origin 是 `https://queue.fal.run`。模型路徑與參數會依固定 adapter 形狀組合，建立後只接受同 origin 的 status／response URL，處理 `IN_QUEUE`、`IN_PROGRESS`、`COMPLETED`，並讀取 `images[].url` 或 `video.url`。官方 queue 文件：<https://fal.ai/docs/documentation/model-apis/inference/queue>。

## Replicate

預設 API origin 是 `https://api.replicate.com/v1`。模型使用 `owner/name` profile，建立 `POST /models/{owner}/{name}/predictions`，以 Bearer env key 傳送 `input`，再以 `GET /predictions/{id}` 輪詢 `starting`、`processing`、`succeeded`、`failed` 或 `canceled`。官方 HTTP 文件：<https://replicate.com/docs/reference/http/>。

## 來源與限制

React Flow 的保存與還原概念參考官方範例：<https://reactflow.dev/examples/interaction/save-and-restore>。provider URL 只允許 operator 設定的 exact HTTPS origin；禁止 redirect、credentials、query／hash、IP literal 與跨 origin 結果。媒體 URL 需符合 media allowlist，瀏覽器以 `no-referrer`、`crossOrigin="anonymous"` 載入。自訂 model 是使用者 profile，不等同於已驗證的官方模型；供應商 live 狀態需另行驗證。
