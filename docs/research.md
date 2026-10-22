# 研究紀錄

本紀錄只整理公開介面觀察與官方協定文件，不複製商標、程式碼或素材，也不推論登入後畫布或 backend 行為。

## 公開 UI 觀察

研究目標為 [LibTV 官方網站](https://www.libtv.com/)。公開首頁可見畫布創作、Agent、素材／專案／插件，以及圖片、影片、音訊、腳本等入口；Relay Canvas 以節點資料流和 agent 操作能力作為獨立產品的設計方向。

REA 觀察到首頁證據 `ev_7b8c4e4ae215c74bb74aa803fc4c37bb7cd45a797178d3f44469288212e8eeae`。關閉 promotion 後按新建畫布會進入微信／手機／團隊 email 登入 gate，證據為 `ev_0969509f93ae5f8f607de5974e6e68482cac6cdaf2dcc56d9181ccf42b969beb`。另一次 click 被 promotion 擋住並 timeout，證據為 `ev_9d5c33731c79a211bdf18493b66a81485731c920d2e5fd6d0c7351865e521176`。

這些證據只支持公開 UI 的有限描述；未知的登入內功能、backend、實際生成與付費狀態不列為驗收事實。

## 協定來源

- React Flow save／restore：<https://reactflow.dev/examples/interaction/save-and-restore>
- fal queue：<https://fal.ai/docs/documentation/model-apis/inference/queue>
- Replicate HTTP API：<https://replicate.com/docs/reference/http/>

## 驗收界線

Demo 與 protocol fixtures 可在本機驗證；CI 執行 TypeScript、測試、build、Chromium smoke 與 release package checks。付費 provider 的 live generation 沒有授權，因此保留為未執行，不能從 fixture 推導 live 成功、價格、速度或輸出品質。
