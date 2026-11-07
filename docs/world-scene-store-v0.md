# World Scene Store v0｜PR-02實作契約

狀態：Draft／Sidecar Prototype  
依賴：World IR v0（`feat/world-ir-2046-foundation`，PR #4）  
變更：`server/world-store.ts`、`server/app.ts`、`tests/world-store.test.ts`

## 設計目標

為ReachFlow建立**獨立、可重載、可稽核的World IR場景儲存層**，讓未來Three.js、LangGraph、Blender與世界模型共用同一份已核准世界狀態。保持現有Board v1、DAG、Provider、Run、Timeline及原有MCP工具不變。

- 既有`workspace.json`維持原狀。
- 新增單一`world-scenes.json`sidecar，保存在已驗證的`RELAY_DATA_DIR`。
- 每次成功修改都追加一筆完整World IR快照，包含Revision、SHA-256與操作收據。
- 只允許明確指定`confirmApproved: true`且所有Entity／Camera／Shot／Event的`authority=approved`之內容寫入。
- `confirmApproved`**不是**身份鑑別或人類審查證明；它只是避免意外將Proposal當成Approved State。真正的提案／人工核准流程屬PR-03。

## 端點

所有端點沿用目前`createBoundary`的Origin、Session Token與Host保護。

| Method | Path | 用途 |
|---|---|---|
| GET | `/api/worlds/:worldId/scenes/:sceneId` | 讀最新版本 |
| GET | `/api/worlds/:worldId/scenes/:sceneId?revision=1` | 讀指定歷史版本 |
| GET | `/api/worlds/:worldId/scenes/:sceneId/revisions` | 列出Revision、SHA-256及寫入時間 |
| PUT | `/api/worlds/:worldId/scenes/:sceneId` | 建立或寫入新版本 |

### PUT request

```json
{
  "expectedRevision": 0,
  "operationId": "my-unique-operation-id",
  "confirmApproved": true,
  "scene": {
    "schemaVersion": 1,
    "worldId": "world_demo",
    "sceneId": "scene_demo",
    "revision": 0,
    "coordinateFrame": "RH_Y_UP_METERS",
    "timebase": {"fpsNumerator": 24, "fpsDenominator": 1},
    "durationSeconds": 6,
    "entities": [],
    "cameras": [],
    "shots": [],
    "relations": [],
    "events": [],
    "constraints": []
  }
}
```

建立第一筆Revision時，`expectedRevision=0`，`scene.revision=0`；成功後Revision為1（HTTP 201）。下一次寫入須帶Revision1及使用新的`operationId`（HTTP 200）。

### PUT response

```json
{
  "scene": { "...": "完整World IR，revision已遞增" },
  "sha256": "64-character SHA-256",
  "committedRevision": 1,
  "currentRevision": 1,
  "replayed": false
}
```

使用相同`operationId`、相同`expectedRevision`和內容重試時不會再次寫入。回傳原始提交的`scene`與`committedRevision`；若其他修改已發生，`currentRevision`可能較新，前端不可將舊重播結果當成最新場景覆寫。

## 錯誤契約

- 400 `INVALID_WORLD_ID`：URL包含不允許的ID字符。
- 400 `INVALID_WORLD_WRITE`：缺欄位、未宣告欄位、格式或`confirmApproved`錯誤。
- 400 `WORLD_IDENTITY_CONFLICT`：World/Scene與URL不一致。
- 400 `WORLD_REVISION_MISMATCH`：Body內的Scene revision與expectedRevision不同。
- 404 `WORLD_NOT_FOUND`：場景或要求的歷史Revision不存在。
- 409 `WORLD_REVISION_CONFLICT`：有其他提交已更新此場景。
- 409 `WORLD_OPERATION_CONFLICT`：同一operationId被用於不同輸入。
- 409 `WORLD_REVIEW_REQUIRED`：存在未核准提案。
- 409 `WORLD_STORAGE_LIMIT`：原型儲存上限；需遷移正式資料庫。
- 500 `WORLD_STORE_INVALID`：Sidecar受損、權限異常或不可信，**拒絕覆寫**。
- 500 `WORLD_STORAGE_FAILED`：原子寫入失敗。

## 安全及一致性邊界

- 原型依賴Node.js單一Server及現有Workspace Lock；多進程共用檔案**不在支援範圍**。多人／Cluster需改為交易式DB、唯一鍵和隔離鎖。
- `world-scenes.json`只允許權限0600的普通檔，拒絕Symlink與損毀歷史。
- 事件歷史保留所有版本，不靜默清除冪等操作收據；32MiB或10000次成功寫入上限是**原型保護閥**，不是產品容量設計。遷移時保留所有Scene與operationId。
- 每筆Revision以World IR正規化後的JSON計算SHA-256，可核對完整性；**不是數位簽章或防惡意竄改證明**。
- World與Canvas沒有相互綁定的跨儲存交易；未來PR-05才提供`ShotPackage`的Scene Revision／Hash引用。
- 權利管理（asset license）、多使用者認證、提案審批、審計身份及加密儲存都留給後續階段。

## 驗收

```bash
npm run check
npm test
npm run test:release
npm run build
```

必須覆蓋：

1. 首次建立、讀回、再次修改、指定歷史Revision與重啟後讀回。
2. Stale Revision回409且Journal逐Byte不變。
3. 相同operationId的重試不產生第二筆Revision，重啟後仍能識別。
4. 相同operationId不同內容回409且無副作用。
5. Proposal被拒絕，絕不混入已核准狀態。
6. 壞引用、ID不符、無效欄位、無權限／不安全Sidecar拒絕。
7. 未授權HTTP請求被既有安全Boundary阻擋。
8. 執行World API後，舊`workspace.json`和Board資料不變。

## 接續工作

**PR-03 Scene Proposal Engine**：Propose→Validate→Diff→Human Review→Commit；基於Scene Revision CAS，加入具身份的審核記錄、提案期限、審批撤回與事件來源。不得由LLM直接調用已核准場景的PUT端點。PR-04才引入Three.js Director View。
