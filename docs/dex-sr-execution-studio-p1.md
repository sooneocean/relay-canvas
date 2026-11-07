# DE-X SR Execution Studio P1: 1080p非生成式修復操作流程

Status: **Draft、Linux-first本機實驗功能**。疊加PR #16→#15→#14。沒有合併、沒有部署正式環境、不會呼叫Seedance或付費API。原始影片只讀，輸出獨立MP4。

## 使用者操作流程

1. 在ReachFlow畫布以`Import media`匯入當前影片、可選的前段影片，以及至少一張**原始**人物或場景圖片；也可以使用已成功執行且保存到本機的影片片段。圖片必須是本畫布的匯入資產。
2. 點擊畫布工具列`德式超分`。
3. 選擇待修復影片、可選的前段片段；為每張原圖指定Identity（只記錄）、Detail（僅同視角匹配時轉移真實高頻殘差）、Scene（僅同視角匹配）、Color（只記錄）。最多8張。
4. 輸入保真提示詞。提示詞**不會交給LLM**；Worker只辨識保真、保持五官、保留顆粒等有限詞彙，用來降低數值融合強度。
5. 點`預檢來源`，伺服器會重新驗證每個SHA-256、畫布權限、當前片段長度與尺寸；它不宣稱已完成跨視角身分辨識。
6. Python/OpenCV引擎可用且預檢成功後，點`執行保真修復`。工作使用既有Export日誌記錄，並支援查詢、取消與伺服器重啟後標示中斷。
7. 完成後使用`同步播放／暫停`、原始與修復影片並列對照，或下載獨立的1080p MP4結果。原片不覆寫，也不回灌Seedance。

## API

`GET /api/dex-sr/capabilities`：檢查本機Python3、cv2、numpy、FFmpeg/FFprobe與受信任的Worker檔案。這是局部依賴檢查，不代表真實影片效果合格。

`POST /api/boards/:id/dex-sr/plan`：使用前一階段既有唯讀來源驗證，不產生付費費用。

`POST /api/boards/:id/dex-sr/jobs`：Body `{operationId,bundle}`，其中bundle與既有plan API相同；idempotency以完整bundle的SHA-256比較，嚴格拒絕同operationId不同內容。回應202的`ExportJob`。

`GET /api/exports/:id`：工作狀態、來源manifest、輸出MP4的本機URL。`POST /api/exports/:id/cancel`：取消正在執行的Python/FFmpeg子進程群組。

## 可靠性邊界

- 初版只允許1–8秒、SDR、定幀率、短邊至少270px且面積不超過1280×720的影片；最多8張圖片、2幀半徑與4倍放大。Python層獨立檢查FPS、影格PTS、色彩標籤、格式與輸出限制。
- 伺服器只把已登錄在當前畫布的MP4/WebM影片與原始匯入圖片，透過MediaStore按實際位元組驗證再搬到私有暫存目錄。任何使用者提供的路徑或任意網路URL都不會進入執行命令。
- Python Worker使用OpenCV Farneback光流、前後誤差、場景切換拒絕、同視角匹配的高頻實測參考與低解析反投影，**完全沒有生成模型、換臉、GAN或Diffusion**。
- 長度與資源限制不表示百分之百能避免OOM，完整生產部署仍需容器層CPU/記憶體隔離、配額與清理程序。
- Python產生的16-bit FFV1/MKV為暫存中間結果；**本PR只永久保存可供瀏覽器播放的H.264/yuv420p MP4**。這個交付轉碼會有色度損失，尚未實作FFV1母帶持久保存，不能稱為完全無損工作流程。
- 原始多角度身分圖片不會直接轉成其他臉部姿態，更不會貼回目前影片。若原始觀測沒有某些細節，輸出不能保證還原。
- 執行失敗、逾時或取消時，Source檔案、Board資料及成功輸出都維持不可變；狀態標示Failed/Cancelled，**不會無限重試**。

## 部署前本機準備

需要由環境管理者在允許的Python環境安裝`tools/requirements-precision-vsr.txt`，且該`python3`可由服務的PATH找到。依賴**不會在使用者按下執行時自動下載或安裝**。

```bash
python3 -m pip install -r tools/requirements-precision-vsr.txt
npm run check
npm test
npm run build
npm run dev
```

只有當API顯示`available: true`，且已匯入符合規格的影片/圖片，介面才允許啟動。Mac/Windows原生環境、GPU加速、完整長片分段、FFV1持久保存、影格級品質報告與企業多租戶權限都不是此PR的驗收範圍。

## 驗收與後續

- Node CI：來源綁定、同畫布驗證、持久工作狀態、Operation ID重播、取消、Origin/Session Token保護以及無模型呼叫。
- Python CI：真實影片影格與音訊保留、前段影片多幀記憶、原始多圖驗證、光流重建與原始低解析資料一致性。
- Browser/Release CI：UI型別、打包時包含Python腳本與requirements、舊有Canvas/Timeline/E2E相容性。
- 下一階段：持續保留專業FFV1/MOV母帶、基於真實人物影片的Temporal Face Fidelity量測，以及可選的BasicVSR++重建型權重（PSNR/L1、非GAN/非Diffusion）比較Topaz Proteus Natural。