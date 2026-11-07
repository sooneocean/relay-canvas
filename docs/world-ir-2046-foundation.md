# ReachFlow 2046｜World Creation OS與World IR v0基礎決策

狀態：**Research/Prototype（尚未接入正式產品）**  
基準日：2026-11-07  
維護者：ReachFlow Engineering  
相關程式：`src/shared/world-ir.ts`；測試：`tests/world-ir.test.ts`

## 1.目標：讓世界成為第一級資料，而非讓影片成為世界

ReachFlow未來20年的可持續基礎是：

- **Intent Plane**：創作目的、限制、參考素材、人類裁決。
- **World Plane**：持續存在的人物、場景、物件、攝影機、時間、關係。
- **Intelligence Plane**：Scene/Shot Compiler、LangGraph審批式Agent、評測器。
- **Execution Plane**：Three.js、Blender、ComfyUI、LLM、影片／世界模型、未來硬體。
- **Evidence Plane**：素材指紋、來源、授權、執行快照、品質、人工反饋。
- **Experience Plane**：2D畫布、3D導演台、Timeline、XR、對話介面。

**不變原則：世界的可核對結構與生成式視覺結果必須分離。**
新世界模型的輸出只應產生Proposal或衍生資產，不能未經核准直接覆寫Approved World State。

## 2.目前公開專案基線

本次審核基準：`sooneocean/relay-canvas`公開`main`於`d0544a0b567d9afc0300c4f46f71422bc4633c05`。

- `@xyflow/react`12.10、React19、Vite7、TypeScript5.9、Zod3。
- `src/shared/types.ts`的Board Schema v1只有`prompt/image/video/asset/note`五類。
- `server/graph.ts`只允許固定類型連線，不能直接將3D場景當成普通ImageNode接入。
- `server/store.ts`具原子寫入；`server/service.ts`已實作Board的Revision CAS。
- `server/mcp.ts`已提供畫布、生成、保存、Timeline等工具，尚未提供World工具。
- 公開`main`相依中未顯示LangGraph。可能另有內部Gitea或不同分支：正式導入前須比對部署SHA與現有Previz／Agent實作。

因此本PR**僅新增獨立World IR Schema及測試**，不變更既有Board資料、DAG、Provider、Run、Store、MCP、Jenkins和正式站。

## 3.World IR v0契約

`schemaVersion=1`，`coordinateFrame=RH_Y_UP_METERS`：右手座標、Y軸向上、長度公尺；時間以秒表示，`fpsNumerator/fpsDenominator`明確表示影格速率。

目前最小概念：

| 記錄 | 欄位 | 為何存在 |
|---|---|---|
| World header | worldId、sceneId、revision、時間基準 | 可遷移、可重載 |
| Entity | 穩定ID、kind、Transform、Authority、Provenance | 角色和道具不跟隨影片消失 |
| Camera | Transform、focalLength、sensorWidth、focusDistance、fStop | 真正可重建鏡位 |
| Shot | CameraId、開始／結束時間、創作意圖 | 分鏡與生成的橋接 |
| Event | SubjectId、時間、事件類別與描述 | 未來4D／互動世界基礎 |
| Relation | parent、looks_at、interacts_with、near | 基礎空間／敘事關係 |
| Constraint | 目標ID、soft／hard、條件文字 | 可見的創作限制，非可執行腳本 |

Schema限制、拒絕條件：
- 非有限數值、非法Quaternion、非正Scale及鏡頭參數。
- 重複ID、遺失參考、父子關係循環、越界Shot與Event。
- 未宣告欄位、任意命令、Provider秘密與無界模型輸出。
- Entity最大256、Camera最大32、Shot最大256、Event最大2048。這些是**v0單Scene安全預設**，不是2046產品上限；未來可按分區、串流或分頁擴充。

**不是本PR要解決的問題**：這個IR不直接證明物理正確性、不替代OpenUSD、不包含GLB／影格資料、不負責持久化、版本合併或實際Agent審批。

## 4.長期技術採納決策

| 技術方向 | 2026立即做 | 中期導入 | 長期擴展 |
|---|---|---|---|
| Typed World／Scene IR | 建立契約、Migration測試 | 世界版本分支、Event Log | 持久互動世界 |
| Three.js＋R3F＋Drei | 單一3D導演台原型 | 幾何查詢、角色走位、運鏡 | 高階即時空間UI |
| OpenUSD／glTF | 定義匯入匯出邊界 | Blender互通、USD Composition | 大規模跨工具場景 |
| World Models | Adapter ABI、離線固定評測 | 隔離研究接入 | 取代部分視覺模擬 |
| LangGraph＋MCP | Proposal→Diff→Review契約 | 任務恢復、協作Agent | 長時間多任務創作 |
| ComfyUI／生成API | Provider Capability Map | Dynamic Scheduler、評分與路由 | 可移植媒體產線 |
| OpenTimelineIO | 定義Shot與Clip對映 | 匯入匯出剪輯語義 | 跨媒介作品重組 |
| XR／機器人／現場控制 | 僅預留座標及權限欄位 | 獨立沙盒實驗 | 需求與安全條件成立後採用 |
| Provenance／C2PA | 保存資產Hash與權利欄位 | 簽章、審計、輸出證明 | 可驗證世界產物 |

不得以單一供應商模型、單一渲染器或單一AI框架作為長期權威資料格式。

## 5.因應世界模型演進的雙層真相

```text
Approved World State
   ├── persistent IDs / spatial transforms / constraints
   ├── human-approved scene and shot history
   └── source provenance and asset rights
            │
    versioned snapshot / capability contract
            ▼
Generative Model / Blender / Three.js / World Model
            │
       derived artifact / proposed patch
            ▼
Review, Evaluation, Rights Check, Cost Approval
            │
      explicit approval only
            ▼
       next World revision
```

模型能力越強，輸出可能越自由；但沒有可觀測的3D真相時，不能把生成畫面中的角色位置視作已證實座標。Future World Adapter必須標示`supportsSpatialControl`、`objectPermanence`評測、`maxContext`、`sideEffects`、成本與資料政策。

## 6.下一階段PR（須待本契約通過審查）

- **PR-02｜World Sidecar Store**：`GET /api/worlds/:id/scenes/:sceneId`、`PUT`帶`expectedRevision`，409衝突；`operationId`確保冪等；不覆蓋Board。
- **PR-03｜Scene Proposal Service**：`propose -> validate -> diff -> approve/reject -> commit`。拒絕零副作用；核准僅作用於預期Scene Revision。
- **PR-04｜Director View**：一個WebGL Canvas，Three.js＋React Three Fiber v9＋Drei，3人物、2相機、3分鏡。
- **PR-05｜Shot Compiler**：`WorldSnapshot+Shot+ModelCapabilities`→`ShotPackage`，包含參考影格、鏡頭數值、場景Hash、約束與權利提示。
- **PR-06｜Typed DAG Bridge**：與既有Graph融合，保持舊五類節點行為；使用版本化Port和Capability Manifest。
- **PR-07｜Evaluation Harness**：跨鏡頭人物一致性、視線／軸線、參考影格遵守度、成本、失敗恢復。
- **PR-08｜Blender／OTIO／World Model Sandbox**：先讀取及輸出、建立差異報告；無權改動Approved State。

## 7.驗收條件

本PR：
1. `npm run check`、`npm test`、`npm run build`應通過。
2. World IR合法資料可JSON Round-trip。
3. 重複ID、遺失相機、循環Parent、越界時間、NaN、未宣告欄位都應拒絕。
4. 不變更既有Schema v1及正式API；已有Boards讀寫與Run行為不受影響。
5. 不連線任何付費外部模型，不更改正式站／Gitea主線。

PR-02之後：必須額外測CAS、撤銷／重做、審批拒絕無副作用、重啟恢復、端到端3D→Shot→Video，以及付費任務避免重複送出。

## 8.2026–2046四階段（情境而非承諾）

- **2026–2031｜Creative Intelligence OS**：結構化創作、3D導演台、Agent工具、品質評測、可靠生成。
- **2031–2036｜Persistent World OS**：角色、物件與敘事世界跨作品保存，必要時以世界模型補足互動外觀。
- **2036–2041｜Cognitive Simulation OS**：在可驗證範圍內支援因果與what-if模擬，禁止把視覺真實誤認為預測可靠。
- **2041–2046｜Reality Orchestration OS**：條件成熟時跨XR、互動電影、現場製作設備／數位孿生；實體動作必須獨立安全邊界及人類監督。

### 長期五個不變KPI

1. **Portability**：換渲染器、模型及UI後可保留多少語義。
2. **Controllability**：模型是否準確遵守相機、人物、時間約束。
3. **Consistency**：世界狀態是否跨鏡頭／跨時間保持一致。
4. **Reliability**：失敗、重試、恢復與成本能否驗證。
5. **Learning Yield**：經驗收的Skill能否在新專案重複取得可測量改善。

## 9.參考與風險

- Google DeepMind Genie 4（2026-10-27，研究預覽，官方坦承長時間一致性與物件持續性仍有限）：https://deepmind.google/blog/genie-4-a-new-generation-of-world-simulation/
- NVIDIA Cosmos 3（Physical AI世界模型）：https://research.nvidia.com/labs/cosmos-lab/cosmos3/
- OpenUSD Scene Composition：https://openusd.org/release/intro.html
- OpenTimelineIO：https://github.com/AcademySoftwareFoundation/OpenTimelineIO

**限制**：本次僅驗證公開GitHub版本。私有Gitea正式開發主線與Jenkins部署SHA未在本PR中比對完成，不能宣稱已整合正式ReachFlow。
