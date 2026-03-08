---
name: comprehensive-code-review
description: |
  Complete code review framework with mandatory tool-verified checks and anti-hallucination enforcement.
  Use when: performing code reviews, reviewing PRs, checking code quality before merge.
  Keywords: code review, review code, 代碼審查, PR review, pull request, 檢查代碼.
  Auto-triggers on: "code review", "review the code", "run code review".
---

# Comprehensive Code Review Framework v4.0

**Philosophy**: 不信任自己。用工具證明一切。沒有 evidence 的 check 等於沒做。

**v4.0 vs v3.0**: v3.0 說了「應該檢查什麼」但沒強制怎麼做。v4.0 的每一步都是**必須用工具執行並產出 evidence** 的指令，不是建議。

---

## 🔴 Step 0: Ripple Map（強制首步，不可跳過）

**PURPOSE**: 在做任何 review 之前，先找出所有「改了 A 就必須改 B」的連鎖反應。

**這是 v4.0 最重要的改變。** 之前的 review 只看「已改的檔案寫得對不對」，從不問「還有哪些檔案該改但沒改」。

### 執行方式（必須用工具）

```
FOR EACH modified file:
  1. 找出這個文件中被新增/修改的 export（type, function, constant）
  2. Grep 整個 codebase 找出所有 import 這些 export 的文件
  3. 這些文件是否也在本次修改範圍內？
     - 是 → 後續 review 時檢查一致性
     - 否 → 🔴 SUSPECT: 可能遺漏。立即 Read 該文件確認是否需要更新
```

### 必須執行的工具命令

```bash
# 1. 列出所有修改的文件
git diff --name-only HEAD  # 或 review 指定的文件列表

# 2. 對每個被修改的 interface/type/function，搜尋所有引用
Grep: pattern="DeliverParams"  # 每個被修改的型別名
Grep: pattern="deliverOrder"   # 每個被修改的函數名
Grep: pattern="delivery_result" # 每個被新增的 DB column

# 3. 比對：引用這些東西的文件 vs 本次修改的文件
#    差集 = 可能遺漏的文件
```

### Ripple Map Output 格式（必須產出）

```
## Ripple Map

| Changed Symbol | Files That Reference It | In Scope? | Verified? |
|----------------|------------------------|-----------|-----------|
| `DeliverParams` | sdk/types.ts, sdk/client.ts, deliver/route.ts | ✅/❌ | Read 確認 |
| `deliverOrder()` | client.ts, sdk/client.ts, example/index.ts | ✅/❌ | Read 確認 |
| `delivery_result` | supabase.ts, api-utils.ts, deliver/route.ts | ✅/❌ | Read 確認 |

🔴 Unsynchronized: [列出所有引用但未修改的文件]
```

**如果 Ripple Map 發現 unsynchronized 文件，直接列為 CRITICAL issue，不需要進入後續維度。**

---

## Step 1: Scope Analysis

確認審查範圍：
- 哪些文件被修改？（用 git diff 或文件列表，不可憑記憶）
- 變更的目的是什麼？
- **有幾個 package/module 邊界被跨越？**
- **Ripple Map 發現多少個 unsynchronized 文件？**

---

## Step 2: Mandatory Verification Dimensions

**12 個維度。Dim 11 和 12 是最高優先級，必須用 Explore subagent 或多個 Read/Grep 並行執行。**

**每個 check 必須產出 evidence。格式：**
```
[DIM-11a] ✅ PASS — import { validateOutputSchema } from '@/lib/api-utils'
  Evidence: Read api-utils.ts → line 118: export function validateOutputSchema(...)

[DIM-12d] 🔴 FAIL — SDK DeliverParams missing deliveryResult
  Evidence: Read packages/sdk/src/types.ts:177-180 → only has deliveryHash, deliveryMetadata
```

**沒有 evidence 的 ✅ 等於 ❌。**

---

### 🔴 Dim 11: Reality Check（必須用 Explore subagent 執行）

**IMPORTANT: 這個維度必須 dispatch 至少一個 Explore subagent 來獨立驗證。不可自己看一眼就說 PASS。**

**Subagent prompt 模板**:
```
In [project_path], verify the following for files [list]:
1. Every import resolves to a real export (read the source file to confirm)
2. Every method call references a method that exists in the target class
3. Every DB column referenced exists in migrations
4. Search for TODO/FIXME/STUB in all modified files
5. For every new function: grep for callers — is it actually called from somewhere?
Report exact findings with file:line evidence for each.
```

**11a-11f 檢查項目**（subagent 必須全部執行）：

| Check | Tool | What to verify |
|-------|------|----------------|
| 11a. Import/Export | Read 被 import 的文件 | export 真的存在 |
| 11b. Method calls | Read 被呼叫的 class | method 真的定義了 |
| 11c. DB schema | Read migration files | column 在 migration 裡 |
| 11d. Example code | Read constructor + method 簽名 | 參數和回傳值匹配 |
| 11e. Stubs | Grep TODO/FIXME/STUB/throw.*not.impl | 無假完成 |
| 11f. Dead wire | Grep function name across codebase | 有 caller 存在 |

---

### 🔴 Dim 12: Cross-boundary Sync（必須用 Explore subagent 執行）

**IMPORTANT: Monorepo 或多 package 專案時，此維度必須 dispatch 獨立 subagent。**

**Subagent prompt 模板**:
```
In [project_path], check cross-boundary type synchronization:
1. Compare [platform types file] with [SDK types file] — list every interface
   that exists in both. For each, compare field-by-field.
2. Compare [platform client file] with [SDK client file] — list every method
   that exists in both. For each, compare signature.
3. For every API route that accepts a body: read the route handler AND the SDK
   method that calls it. Do the field names match?
4. Trace: migration column → DbType → mapResponse → API type → SDK type.
   Report any broken links.
Report ALL mismatches with exact file:line evidence.
```

**12a-12d 檢查項目**（subagent 必須全部執行）：

| Check | What | How |
|-------|------|-----|
| 12a. Type parity | 同名 interface 欄位一致 | Read 兩個 type 文件，逐欄比對 |
| 12b. Client parity | 同名 method 簽名一致 | Read 兩個 client 文件，逐方法比對 |
| 12c. Route↔SDK match | Route body 欄位 = SDK params 欄位 | Read route + SDK method |
| 12d. Full chain | migration→DbType→mapper→ApiType→SdkType | 追蹤新增欄位通過每一層 |

---

### Dim 1-10: Standard Quality Dimensions

#### 1. 🔒 Security
- Injection attacks (SQL, Command, Path traversal)
- Sensitive data exposure
- Auth/AuthZ gaps, hardcoded secrets

#### 2. 🔄 Concurrency
- Race conditions (TOCTOU), deadlocks
- Atomic operation needs

#### 3. 💾 Resource Management
- Resource leaks, unbounded buffers
- Timer/listener cleanup

#### 4. ❌ Error Handling
- Uncaught exceptions, empty catch
- Unhandled Promise rejections

#### 5. 📊 Edge Cases
- Empty/null/NaN/zero/MAX values
- First run / cold start

#### 6. ✅ Input Validation
- Type, range, format, length validation

#### 7. ⚡ Performance
- O(n²), blocking I/O, N+1 queries

#### 8. 📝 Code Quality
- Dead code, magic numbers, naming

#### 9. 📖 Documentation
- API docs, outdated comments

#### 10. 🧪 Test Coverage
- Happy/error/edge paths tested
- New functions have corresponding tests

---

## Step 3: Issue Classification

| Level | Symbol | Criteria | Action |
|-------|--------|----------|--------|
| CRITICAL | 🔴 | Security, crash, **hallucination, broken integration, missing sync** | Fix immediately |
| MAJOR | 🟠 | Bugs, leaks, performance, type mismatch | Fix before merge |
| MINOR | 🟡 | Quality, maintenance | Document |

**鐵則**: Dim 11/12 的 issue 最低 MAJOR，大部分 CRITICAL。

---

## Step 4: Fix Dispatch

```
Dispatch subagents in parallel (max 6):
- Group by file or logical module
- Each subagent: fix root cause → run related tests → validate no regression
- After all complete: run full test suite
- After full suite: re-run Ripple Map to verify no new gaps
```

---

## Step 5: Final Verification Gate

**在宣稱 review 完成前，必須全部通過：**

```
□ Ripple Map 無 unsynchronized 文件
□ Dim 11 所有 check 有 evidence 且 PASS
□ Dim 12 所有 check 有 evidence 且 PASS
□ 所有 CRITICAL issues 已修復
□ 所有 MAJOR issues 已修復
□ MINOR issues 已記錄
□ tsc --noEmit pass（主專案）
□ tsc --noEmit pass（每個子 package 獨立跑）
□ 全部測試 pass
□ Build pass
```

**如果任何 check 缺少 evidence，整個 review 標記為 INCOMPLETE。**

---

## AI 幻想模式速查表

| # | Pattern | 怎麼偵測 | 工具 |
|---|---------|---------|------|
| 1 | **Ghost Method** — 呼叫不存在的方法 | Read class file, search method | Read |
| 2 | **Phantom Import** — import 不存在的 export | Read source file | Read/Grep |
| 3 | **Schema Drift** — 讀寫不存在的 DB column | Read all migrations | Read |
| 4 | **Type Island** — 只改一邊的 type | Ripple Map 自動抓 | Grep |
| 5 | **Dead Wire** — 定義了但沒被呼叫 | Grep function name | Grep |
| 6 | **Stub Disguise** — TODO/return {} 偽裝完成 | Grep TODO/FIXME/STUB | Grep |
| 7 | **Constructor Lie** — 參數不匹配 | Read constructor | Read |
| 8 | **Mock Leak** — test mock 了但 prod 沒實作 | Check real implementation | Read |
| 9 | **One-side Fix** — 改了 A 忘改 B | Ripple Map 自動抓 | Grep |
| 10 | **Verify Theater** — tsc pass 但只跑主 package | 獨立跑每個子 package tsc | Bash |

---

## 何時執行

| 觸發條件 | 執行範圍 |
|---------|---------|
| 新功能 > 100 lines | Full review (all 12 dims) |
| API/DB schema 變更 | Full review + 強制 Dim 11/12 |
| 跨 package 變更 | Full review + 強制 Dim 12 |
| Bug fix < 50 lines | Quick review (Dim 11 + 改動相關維度) |
| 任何 monorepo 變更 | 至少 Ripple Map + Dim 12 |

---

**Version**: 4.0
**Last Updated**: 2026-02-22
**Changelog**:
- v4.0: 新增 Step 0 Ripple Map — 強制發現遺漏的連鎖修改
- v4.0: Dim 11/12 必須 dispatch Explore subagent 獨立驗證
- v4.0: 每個 check 必須產出 evidence，無 evidence = 未完成
- v4.0: 新增 Verify Theater pattern（tsc pass 但只跑主 package）
- v4.0: 新增 Final Verification Gate — 子 package 必須獨立跑 tsc
- v3.0: Added Dim 11/12, hallucination pattern table
- v2.0: Initial 10-dimension framework
