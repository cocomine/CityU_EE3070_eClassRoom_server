下面係你而家「Task-based、LLM 非串流、SSE 只通知狀態」架構下，**伺服器收到建立任務請求（Create Task）後**的完整處理流程（由
API → Redis → BullMQ → Worker → SSE → Result）。

---

## 端到端流程（Create Task 後）

### 1) API 收到請求 OK

**Client → Server**
`POST /v1/subjects/:subjectId/tasks`
Body：`clientTaskId, taskPrompt, options`

Server 做基本檢查：

* `subjectId` 是否有效（如有 subject 列表）
* `taskPrompt` 非空、長度上限
* `clientTaskId` 存在（UUID）

---

### 2) 冪等處理（Idempotency）OK

**目的：** 防止 iOS 重送造成重複扣費/重複生成。

* Redis：`GET idem:task:{clientTaskId}`

    * 若存在 → 直接回傳之前的 `{taskId, statusStreamUrl, resultUrl}`
    * 若不存在 → 繼續

（寫入建議）

* `SET idem:task:{clientTaskId} {taskId} NX EX 86400`

---

### 3) 建立 taskId + 初始化狀態（PENDING）OK

Server 生成：

* `taskId`（UUID/ULID）

寫入 Redis meta（Hash）：

* `task:{taskId}:meta`：

    * `subjectId`
    * `status = PENDING`
    * `createdAt = now`
    * `startedAt = null`
    * `finishedAt = null`
    * `errorMessage = null`

---

### 4) 回應 Client（立即）OK

Server 回：

* `taskId`
* `status = PENDING`
* `statusStreamUrl = /v1/tasks/:taskId/status/stream`
* `resultUrl = /v1/tasks/:taskId/result`

> Client 之後立刻開 SSE 訂閱狀態。

---

### 5) Enqueue BullMQ Job OK

Server：

* `queue.add("generateTask", { taskId, subjectId })`

    * jobId 建議用 `taskId`（方便追蹤/去重）

---

## Worker（BullMQ）處理流程

### 6) Worker 開始執行 → 狀態改 GENERATING OK

Worker 取到 job 後：

更新 Redis：

* `HSET task:{taskId}:meta status=GENERATING startedAt=now updatedAt=now`

並且向狀態通道發通知（兩種做法擇一）：

* **Redis Pub/Sub**：`PUBLISH task:{taskId}:status {"status":"GENERATING"}`
* 或者你唔用 Pub/Sub：SSE handler 定時讀 meta（poll）也行，但較浪費

（強烈建議）Heartbeat 防卡死：

* 每 3 秒 `SET task:{taskId}:hb now EX 60`

---

### 7) 呼叫 LLM（非串流，一次性等待完成） OK

Worker 組 prompt：

* system prompt（固定）
* task prompt（client 提供）
* options（可選轉成指令/JSON）

呼叫 OpenAI API：

* **等待完整 response** 返回（不做 token streaming）

---

### 8) 成功完成 → 儲存結果 → 狀態 DONE OK

如果成功拿到最終 question：

1. 存結果（你話只儲存生成後問題）

* `SET task:{taskId}:result <json>`（或存 DB）

    * 例如：`{ text, answer, explanation, ... }`

2. 更新 meta：

* `HSET task:{taskId}:meta status=DONE finishedAt=now updatedAt=now`

3. 通知 SSE：

* `PUBLISH task:{taskId}:status {"status":"DONE"}`

4. （如有 subject activeTask 限制）

* 如果 `subject:{subjectId}:activeTask == taskId` → `DEL subject:{subjectId}:activeTask`

---

### 9) 失敗 → 狀態 ERROR OK

如果 API 失敗/timeout：

* `HSET task:{taskId}:meta status=ERROR errorMessage=... finishedAt=now updatedAt=now`
* `PUBLISH task:{taskId}:status {"status":"ERROR","message":"..."}`
* 清理 activeTask（若有）

---

## SSE Handler（狀態串流）做法 OK

### 10) Client 連 SSE：`GET /v1/tasks/:taskId/status/stream`

SSE endpoint 建議行為：

1. **連線建立時立即推一次當前狀態**

* 讀 `task:{taskId}:meta.status`
* `res.write(event: status, data: {status})`

2. 訂閱狀態更新

* 用 Redis Pub/Sub 訂閱 `task:{taskId}:status`
* 每次收到 publish → 推 SSE `status` event

3. 何時關閉連線

* 收到 `DONE / ERROR / CANCELLED` 後：

    * 再推一次狀態
    * `res.end()`

> 斷線重連：Client 重新連 SSE 即可；因為你會「連線即推當前狀態」，所以不需要 lastEventId。

4. 如果 meta 係 GENERATING，但：

* task:{taskId}:hb 唔存在（過期）或 timestamp 太舊
* → 判定 STALE，回傳 STALE，同時（可選）把 meta 寫成 STALE。

---

## Client 拿最終問題

### 11) Client 收到 DONE 後

呼叫：
`GET /v1/tasks/:taskId/result`

* 若 `DONE` → 回完整問題 JSON
* 若未完成 → 回 202（含 status）

---

## 一句話版本（超短）

1. POST create task → server 建 `taskId`、寫 `PENDING`、enqueue job、回 taskId + SSE url
2. worker start → 設 `GENERATING` + publish → call LLM（non-streaming）
3. worker done → 存結果、設 `DONE` + publish
4. client SSE 收到 DONE → GET result 拉最終問題

---

如果你要，我可以再用 **mermaid 流程圖**畫出「API / Redis / BullMQ / Worker / SSE / Client」泳道圖（swimlane），一眼就睇到每一步做咩。
