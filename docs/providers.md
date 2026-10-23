# Provider 與協定

預設模型僅代表有官方文件的 profile，沒有付費 live 驗證。fal 圖片使用 `fal-ai/flux/schnell`；影片使用 `fal-ai/kling-video/v3/standard/image-to-video`，參考圖欄位是 `start_image_url`。Replicate `minimax/video-01` 使用 `first_frame_image`。UI 選模型時會建議欄位，仍可依中轉站文件手動修改。來源：[fal Kling v3 schema](https://fal.ai/models/fal-ai/kling-video/v3/standard/image-to-video/api)、[Replicate MiniMax inputs](https://replicate.com/minimax/video-01)。舊 Kling v2.1 已被官方標示 deprecated，因此不作為預設。

模型輸出 CDN 的 exact origin 必須加入 `RELAY_MEDIA_ORIGINS`；例如 Replicate 可能回傳 `https://tjzk.replicate.delivery` 等分流域名，這不等於 `https://replicate.delivery`。未加入時安全拒絕顯示及下載，請依供應商文件設定，不會自動放行所有子網域。遠端 URL 可能過期；v0.3 可在到期前明確選擇保存本機。下載不會代送 provider Authorization，因此需要額外受保護下載的輸出仍不支援。見 [本機素材](local-media.md)。

Relay Canvas 以 adapter 介面接入 provider。每個生成請求都由 server 組合安全的 prompt、model、參數與參考欄位；provider 回應會被正規化為 image 或 video artifact。fixture 測試涵蓋建立、輪詢、成功、錯誤 schema、429／500、timeout 與 abort。下列 live URL 是協定文件來源與預設 origin，不代表本專案已完成付費 live smoke。

## Demo

Demo 不做外連。它產生固定程式生成的 SVG data URL 或本機 `/demo-motion.mp4`，用於離線試用與 smoke；SVG 匯入仍被拒絕，避免把任意 HTML 當媒體。

## OpenAI-compatible / New API

以 `POST {baseUrl}/images/generations` 傳送 Bearer env key、model、prompt 與受限參數。OpenAI／relay 圖片請求可選 `n` 1–4（預設 1）及 `response_format` `url`／`b64_json`；UI 只在這兩種圖片契約顯示這些控制，其他協定維持既有欄位。回應的 `data[]` 必須是有序、非空且最多 100 個項目；每個項目都逐一驗證，優先使用 `url`，只有 URL 欄位不存在時才退回 `b64_json`。存在但空白、無效或不允許的 URL 會令整批拒絕；即使 URL 勝出，所有出現的 Base64（包含 data URL 文字）仍計入總 6 MiB 上限。任何後續項目失敗、稀疏陣列、超過 100 個或總量超限，都不保存部分結果。此圖片協定支援 text-to-image，不接受 image input；影片需另選 Videos JSON、fal 或 Replicate 協定。圖片輸出的實際 MIME 仍由 `output_format`／預設 PNG 與保存後的 bytes 共同驗證。OpenAI 圖片 API 的實際欄位應以 operator 選定服務的文件為準。協定欄位參考：[New API plugin usage](https://docs.newapi.ai/en/docs/plugins/usage)。

## 自訂中轉站設定

1. 在 Providers 選擇模板並新增設定。New API／One API 使用 OpenAI-compatible 圖片協定；協定名稱並不保證所有模型可用。
2. 填入服務商的 HTTPS Base URL（常見為 `https://your-relay.example/v1`）、顯示名稱、圖片／影片模型及 `RELAY_KEY_*` 環境變數名稱。
3. 在 server 的 `.env` 設定實際金鑰，將 API 的 exact origin 加入 `RELAY_PROVIDER_ORIGINS`、輸出 CDN 加入 `RELAY_MEDIA_ORIGINS`，啟用 `RELAY_ENABLE_REMOTE=true`，再重新啟動 server。UI 只填變數名稱，不能把金鑰當作 Base URL 或模型參數。
4. 保存 profile 後查看診斷。已配置金鑰只表示 server 找到該環境變數，並不表示金鑰有效或有額度。診斷不呼叫生成端點。
5. OpenAI-compatible／Videos JSON profile 可明確查詢固定 `GET {base}/models`；Demo 使用內建列表。模型列表只代表供應商回傳的 ID，不推斷圖片／影片能力。fal／Replicate 保留手動填模型。

未保存的修改須先保存才能診斷或查詢；失敗時可修改設定並再次嘗試。模型查詢不會暗中執行生成。實際生成仍需逐次費用確認。

## Image + Video JSON 中轉站（`relay`）

`relay` 是一個明確的複合 profile：同一個 HTTPS base URL、exact provider origin 與 `RELAY_KEY_*` 環境變數，分別設定 `imageModel` 和 `videoModel`。它只重用本產品已定義的兩個固定契約：圖片使用 `POST {base}/images/generations`（支援 `n` 1–4 與 `response_format` `url`／`b64_json`），影片使用 `POST {base}/videos`，再以 `GET {base}/videos/{id}` 輪詢。圖片多輸出會保留 provider 回應順序；影片契約與參數維持不變。它不接受任意 endpoint、header、腳本、欄位映射或模型路徑。

OpenAI-compatible 仍是 image-only；Videos JSON 仍是 video-only。`relay` 不把這兩者改成官方 OpenAI Videos，也不宣稱任意中轉站、所有 relay API 或任意模型都相容。image 與 video model 必須分開填寫，並依各自固定契約驗證輸入；圖轉影固定使用 `input_reference.image_url` 傳送同一 run 的上游圖片 URL。

設定流程如下：

1. 在 Providers 新增並保存 `Image + Video JSON 中轉站` profile，填入 exact HTTPS base URL、image model、video model，以及變數名稱（例如 `RELAY_KEY_RELAY`）。
2. 在 server `.env` 設定對應的 `RELAY_KEY_*` 實際金鑰，將 base URL 的 exact origin 加入 `RELAY_PROVIDER_ORIGINS`，將輸出 CDN 加入 `RELAY_MEDIA_ORIGINS`，並在確認可能產生費用後設定 `RELAY_ENABLE_REMOTE=true`。
3. 重新啟動 server，保存 profile 後使用診斷與固定 `GET {base}/models` 查詢（若該 profile 提供此契約），確認模型欄位；查詢不會觸發生成。
4. 在已保存的 relay profile 按「新增圖→影流程」，讓畫布加入一組相連的 image／video 節點。這個動作只建立可編輯的流程，不會自動生成；使用者仍需編輯 prompt、保存畫布、驗證，並在每次 remote run 前確認費用。

未保存的 profile、缺少任一模型或畫布容量不足時，新增流程動作會停用；server 仍會在 click 時重新檢查節點與 edge 容量。沒有 live provider 驗證時，診斷只能表示設定與固定契約狀態，不能表示金鑰有效、模型可用、價格或輸出品質。

## Videos JSON 中轉站

這是供中轉站實作的明確 JSON 相容契約，並非 OpenAI 官方影片服務可用性宣告。官方文件已標示 OpenAI Videos/Sora API 於 2026-09-24 停用；模板不預填官方 Sora 模型。來源：[官方歷史 Videos 文件](https://developers.openai.com/api/reference/resources/videos/methods/create)。

- 建立：`POST {base}/videos`，Bearer env key，JSON `model`、`prompt`；可選 `seconds` 為字串 `4`、`8`、`12`，`size` 為 `720x1280`、`1280x720`、`1024x1792`、`1792x1024`。其他影片參數會在 POST 前拒絕。
- 圖轉影固定使用 `input_reference: { image_url: 原始上游圖片URL }`；本機授權網址不會送給外部模型。
- 建立回傳 `id` 與 `status`；先保存 remote ID，再查詢 `GET {base}/videos/{id}`。
- `queued`／`in_progress` 繼續輪詢；`completed` 必須回傳頂層 `url` 或 `video_url`，並符合媒體 allowlist；`failed` 或未知狀態停止。
- 不支援只提供需金鑰 `/content` 下載的回應，也不支援任意路徑、腳本或 JSON 映射。供應商必須符合上述契約，否則需其他 adapter。

fixture 測試證明請求與錯誤處理契約，不等同於任何實際中轉站的付費 live 驗證。未知 POST 結果不會重送，以免重複計費。

## fal

預設 queue origin 是 `https://queue.fal.run`。模型路徑與參數會依固定 adapter 形狀組合，建立後只接受同 origin 的 status／response URL，處理 `IN_QUEUE`、`IN_PROGRESS`、`COMPLETED`。圖片完成回應的 `images[]` 會依順序保留 1–100 個有效 `url`；任一項無效或缺失就整批拒絕。影片仍只讀取固定的 `video.url`，影片契約不變。官方 queue 文件：<https://fal.ai/docs/documentation/model-apis/inference/queue>。

## Replicate

預設 API origin 是 `https://api.replicate.com/v1`。模型使用 `owner/name` profile，建立 `POST /models/{owner}/{name}/predictions`，以 Bearer env key 傳送 `input`，再以 `GET /predictions/{id}` 輪詢 `starting`、`processing`、`succeeded`、`failed` 或 `canceled`。圖片成功輸出可為有序字串或字串陣列，最多 100 個；每個 URL 會逐一驗證，空值、稀疏或混合無效輸出會令整批拒絕。影片輸出仍沿用既有固定影片形狀。官方 HTTP 文件：<https://replicate.com/docs/reference/http/>。

## 來源與限制

React Flow 的保存與還原概念參考官方範例：<https://reactflow.dev/examples/interaction/save-and-restore>。provider URL 只允許 operator 設定的 exact HTTPS origin；禁止 redirect、credentials、query／hash、IP literal 與跨 origin 結果。媒體 URL 需符合 media allowlist，瀏覽器以 `no-referrer`、`crossOrigin="anonymous"` 載入。自訂 model 是使用者 profile，不等同於已驗證的官方模型；供應商 live 狀態需另行驗證。
