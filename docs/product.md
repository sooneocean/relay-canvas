# 產品說明

Relay Canvas 把一個創作想法拆成可視化節點，讓人先在本機畫布中整理 prompt、圖片與影片關係，再由 Demo 或已設定的 adapter 執行。產品的第一個可見結果是可編輯、可保存、可重載的畫布，而不是聊天視窗。

## 使用流程

1. 啟動本機工作台，從 starter board 開始。
2. 新增或編輯 prompt、image、video、asset、note 節點，拖動並連線。
3. 為生成節點選擇 provider、model、參數與參考欄位。
4. 先驗證 DAG，再執行選定節點及其祖先，或執行整張畫布。
5. 在歷史與素材區查看每個節點的狀態、錯誤與產物。
6. 匯出 board JSON，或讓 Codex 透過 MCP 使用同一組 revision checked API。

## v0.1.0 邊界

prompt 輸出文字，asset 輸出指定的 asset kind，image 輸出圖片，video 輸出影片；note 不接受連線。image 最多接一條 text，video 最多接一條 text 與一條 image。執行只使用同一個 run 的上游圖片產物，不會暗中引用前一次執行。

Demo 是可信的離線 fixture 來源，UI 會明確標示 Demo。遠端生成由 `RELAY_ENABLE_REMOTE=false` 預設關閉，啟用前需要 operator 設定 allowlist 與伺服器金鑰，並在 UI／MCP 明確確認外部生成。取消只停止本機 polling；遠端服務可能仍在處理或計費。

資料以 schemaVersion 1 的 board、provider 與 run 保存於本機 store。每次 mutation 要帶 expected revision；衝突會回傳 409 且不寫入。store 使用原子 temp write + rename；啟動時會把未完成 run 標為 `interrupted`，不自動重送請求。

## Roadmap

v0.2.0 已完成創作首頁、浮動畫布控制、專案卡與成功產物素材庫，詳見 [創作體驗](design-v0.2.md)。本機媒體檔案持久化、更多協定模板與模型能力探索留待後續版本；v0.3 規劃版本比較、時間軸、預算上限、遠端取消與恢復查詢；v1.0 才考慮工作區、權限／稽核、worker、queue、雲端部署與團隊協作。這些後續項目不屬於 v0.2.0 的完成宣告。
