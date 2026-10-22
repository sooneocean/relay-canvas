# Provider 與協定

預設模型僅代表有官方文件的 profile，沒有付費 live 驗證。fal 圖片使用 `fal-ai/flux/schnell`；影片使用 `fal-ai/kling-video/v3/standard/image-to-video`，參考圖欄位是 `start_image_url`。Replicate `minimax/video-01` 使用 `first_frame_image`。UI 選模型時會建議欄位，仍可依中轉站文件手動修改。來源：[fal Kling v3 schema](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api)、[Replicate MiniMax inputs](https://replicate.com/minimax/video-01)。舊 Kling v2.1 已被官方標示 deprecated，因此不作為預設。

模型輸出 CDN 的 exact origin 必須加入 `RELAY_MEDIA_ORIGINS`；例如 Replicate 可能回傳 `https://tjzk.replicate.delivery` 等分流域名，這不等於 `https://replicate.delivery`。未加入時安全拒絕顯示，請依供應商文件設定，不會自動放行所有子網域。遠端 URL 可能過期，第一版不下載保存產物或代送 Authorization；需要受保護下載的輸出尚未支援。

Relay Canvas 以 adapter 介面接入 provider。每個生成請求都由 server 組合安全的 prompt、model、參數與參考欄位；provider 回應會被正規化為 image 或 video artifact。fixture 測試涵蓋建立、輪詢、成功、錯誤 schema、429／500、timeout 與 abort。下列 live URL 是協定文件來源與預設 origin，不代表本專案已完成付費 live smoke。

## Demo

Demo 不做外連。它產生固定程式生成的 SVG data URL 或本機 `/demo-motion.mp4`，用於離線試用與 smoke；SVG 匯入仍被拒絕，避免把任意 HTML 當媒體。

## OpenAI-compatible / New API

以 `POST {baseUrl}/images/generations` 傳送 Bearer env key、model、prompt、`n: 1` 與受限參數，讀取 `data[].url` 或 `data[].b64_json`。首版只支援 text-to-image，不接受 image input，也不宣稱 video 可用。OpenAI 圖片 API 的實際欄位應以 operator 選定服務的文件為準。

## fal

預設 queue origin 是 `https://queue.fal.run`。模型路徑與參數會依固定 adapter 形狀組合，建立後只接受同 origin 的 status／response URL，處理 `IN_QUEUE`、`IN_PROGRESS`、`COMPLETED`，並讀取 `images[].url` 或 `video.url`。官方 queue 文件：<https://fal.ai/docs/documentation/model-apis/inference/queue>。

## Replicate

預設 API origin 是 `https://api.replicate.com/v1`。模型使用 `owner/name` profile，建立 `POST /models/{owner}/{name}/predictions`，以 Bearer env key 傳送 `input`，再以 `GET /predictions/{id}` 輪詢 `starting`、`processing`、`succeeded`、`failed` 或 `canceled`。官方 HTTP 文件：<https://replicate.com/docs/reference/http/>。

## 來源與限制

React Flow 的保存與還原概念參考官方範例：<https://reactflow.dev/examples/interaction/save-and-restore>。provider URL 只允許 operator 設定的 exact HTTPS origin；禁止 redirect、credentials、query／hash、IP literal 與跨 origin 結果。媒體 URL 需符合 media allowlist，瀏覽器以 `no-referrer`、`crossOrigin="anonymous"` 載入。自訂 model 是使用者 profile，不等同於已驗證的官方模型；供應商 live 狀態需另行驗證。
