# 📘 ALUR LENGKAP PROSES SINKRONISASI DATA

## 🎯 Overview
Sinkronisasi data dari MySQL (adsmin_inventory) ke PostgreSQL (advics_system) berjalan otomatis setiap 2 menit.

---

## 🔄 ALUR PROSES LENGKAP

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 1: SCHEDULER TRIGGER (Setiap 2 Menit)
### ═══════════════════════════════════════════════════════════════

**File:** `src/schedulers/syncScheduler.js`

```javascript
// Scheduler menggunakan cron job
Cron expression: */2 * * * * (setiap 2 menit)
```

**Proses:**
1. **Cron job berjalan** setiap 2 menit
2. **Cek apakah ada sync yang sedang berjalan** (`isRunning`)
   - ✅ **Kalau TIDAK ada** → Lanjut ke Tahap 2
   - ❌ **Kalau ADA** → Skip (tunggu sync sebelumnya selesai)
   
**Log yang muncul:**
```
🕐 Starting sync scheduler: every 2 minutes
📅 Cron expression: */2 * * * *
✅ Sync scheduler started successfully
```

**Handling:**
- **Prevent overlapping:** Kalau sync sebelumnya belum selesai, sync baru tidak akan jalan
- **Error:** Kalau ada error, tetap jalankan sync berikutnya (tidak stop scheduler)

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 2: MULAI SYNC PROCESS
### ═══════════════════════════════════════════════════════════════

**File:** `src/services/inventorySync.service.js` → Function `syncInventoryStock()`

**Proses:**
1. **Catat waktu mulai** (untuk hitung durasi)
2. **Set flag** `isRunning = true` (prevent overlap)
3. **Log:** "Starting inventory_stock sync..."

**Log yang muncul:**
```
[2026-02-24 10:00:00] 🔄 ==========================================
[2026-02-24 10:00:00] 🔄 Starting inventory_stock sync...
```

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 3: UPDATE STATUS "RUNNING" DI DATABASE
### ═══════════════════════════════════════════════════════════════

**File:** `src/services/syncState.service.js` → Function `setSyncRunning()`

**Proses:**
```sql
UPDATE sync_state
SET 
  status = 'running',
  updated_at = NOW()
WHERE sync_name = 'inventory_stock';
```

**Tujuan:** 
- Tandai bahwa sync sedang berjalan
- Kalau ada monitoring, bisa lihat status real-time

**Handling Error:**
- Kalau gagal update → Log error, tapi **tetap lanjut sync**

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 4: AMBIL LAST SYNC ID (Progress Tracking)
### ═══════════════════════════════════════════════════════════════

**File:** `src/services/syncState.service.js` → Function `getLastSyncId()`

**Proses:**
```sql
SELECT last_sync_id 
FROM sync_state 
WHERE sync_name = 'inventory_stock';
```

**Hasil:**
- Misal: `last_sync_id = 384`
- Artinya: MySQL record dengan ID ≤ 384 sudah pernah di-proses

**Log yang muncul:**
```
[2026-02-24 10:00:00] ℹ️  Last sync ID: 384
```

**Handling:**
- **Kalau table sync_state kosong** → Initialize dengan `last_sync_id = 0`
- **Kalau ada error** → Throw error, stop sync

**Log kalau initialize:**
```
[2026-02-24 10:00:00] ⚠️  Sync state not found for: inventory_stock. Initializing...
[2026-02-24 10:00:00] ✅ Sync state initialized for: inventory_stock
```

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 5: QUERY DATA BARU DARI MySQL
### ═══════════════════════════════════════════════════════════════

**File:** `src/services/inventorySync.service.js` → Function `fetchNewDataFromMySQL()`

**Proses:**
```sql
SELECT *
FROM inventory_stock
WHERE id > 384          -- Ambil yang lebih besar dari last_sync_id
ORDER BY id ASC         -- Urut dari ID terkecil
LIMIT 5;                -- Ambil 5 record saja (batch)
```

**Hasil:**
Misal dapat 3 record:
```javascript
[
  { id: 385, whs_code: 'WH-LOKAL', part_number: 'ABC123', qty: 10, ... },
  { id: 386, whs_code: 'WH-PUSAT', part_number: 'XYZ456', qty: 20, ... },
  { id: 387, whs_code: 'WH-LOKAL', part_number: 'ABC123', qty: 15, ... }
]
```

**Log yang muncul:**
```
[2026-02-24 10:00:01] ℹ️  Found 3 new records
```

**Handling:**
- **Kalau TIDAK ADA data baru** (rows.length = 0):
  ```
  [2026-02-24 10:00:01] ℹ️  No new data to sync
  [2026-02-24 10:00:01] 🔄 Sync completed (no new data)
  ```
  → Update sync_state dengan status 'success'
  → Selesai (return success)

- **Kalau ADA ERROR** saat query MySQL:
  ```
  [2026-02-24 10:00:01] ❌ Failed to fetch data from MySQL
  ```
  → Throw error
  → Lompat ke TAHAP GAGAL (lihat section bawah)

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 6: AMBIL KONEKSI PostgreSQL
### ═══════════════════════════════════════════════════════════════

**Proses:**
```javascript
connection = await pgPool.connect();
```

**Tujuan:**
- Gunakan satu koneksi untuk semua INSERT
- Lebih efisien daripada buat koneksi baru setiap INSERT

**Handling Error:**
- Kalau gagal connect → Throw error → Lompat ke TAHAP GAGAL

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 7: PROSES SETIAP RECORD (LOOP)
### ═══════════════════════════════════════════════════════════════

Untuk setiap record yang didapat dari MySQL, lakukan:

#### **STEP 7.1: CEK APAKAH MYSQL ID SUDAH PERNAH DI-SYNC**

**Function:** `isAlreadySynced()`

**Proses:**
```sql
SELECT id FROM sync_records
WHERE sync_name = 'inventory_stock' 
  AND source_id = 385     -- MySQL ID
LIMIT 1;
```

**Hasil:**
- **Kalau DAPAT record** (rows.length > 0):
  → Artinya MySQL id=385 **SUDAH PERNAH di-sync**
  → **SKIP record ini** (jangan insert lagi)
  
  **Log:**
  ```
  [2026-02-24 10:00:01] ⚠️  MySQL ID 385 already synced before, skipping to prevent duplicate
  ```
  
  → Counter: `skippedCount++`
  → Lanjut ke record berikutnya

- **Kalau TIDAK DAPAT** (rows.length = 0):
  → Artinya MySQL id=385 **BELUM PERNAH di-sync**
  → **Lanjut ke Step 7.2**

**Handling Error:**
- Kalau query error → Return `false` (anggap belum pernah sync, lanjut insert)

---

#### **STEP 7.2: LOOKUP warehouse_area_id**

**Function:** `getWarehouseAreaId()`

**Proses:**
```sql
SELECT wa.id 
FROM warehouse_area wa
JOIN warehouses w ON wa.warehouse_id = w.id
WHERE w.code = 'WH-LOKAL'    -- whs_code dari MySQL
LIMIT 1;
```

**Hasil:**
- **Kalau DAPAT:** `warehouse_area_id = 5`
- **Kalau TIDAK DAPAT:** `warehouse_area_id = null`
  
  **Log:**
  ```
  [2026-02-24 10:00:01] ⚠️  Warehouse area not found for code: WH-LOKAL, skipping record ID: 385
  ```
  
  → Counter: `skippedCount++`
  → Lanjut ke record berikutnya (SKIP INSERT)

**Handling Error:**
- Kalau query error → Return `null` → Skip record

---

#### **STEP 7.3: LOOKUP item_id**

**Function:** `getItemId()`

**Proses:**
```sql
SELECT id 
FROM items 
WHERE item_code = 'ABC123'    -- part_number dari MySQL
LIMIT 1;
```

**Hasil:**
- **Kalau DAPAT:** `item_id = 10`
- **Kalau TIDAK DAPAT:** `item_id = null`
  
  **Log:**
  ```
  [2026-02-24 10:00:01] ⚠️  Item not found for part_number: ABC123, skipping record ID: 385
  ```
  
  → Counter: `skippedCount++`
  → Lanjut ke record berikutnya (SKIP INSERT)

**Handling Error:**
- Kalau query error → Return `null` → Skip record

---

#### **STEP 7.4: PARSE DATE FIELDS**

**Function:** `parseDate()`

**Proses:**
- Convert string date dari MySQL ke PostgreSQL timestamp
- Handle invalid dates: `null`, `''`, `'0000-00-00'`, `'0000-00-00 00:00:00'`

**Hasil:**
- Valid date → `new Date('2026-02-24')` → PostgreSQL timestamp
- Invalid date → `null`

---

#### **STEP 7.5: INSERT DATA KE PostgreSQL**

**Proses:**
```sql
INSERT INTO inventory_stocks (
  warehouse_area_id,    -- 5
  item_id,              -- 10
  wo,                   -- 0
  qty_qc_hold,          -- 0
  stock_in_day,         -- 0
  qty,                  -- 10
  status_stock,         -- 0
  date_in,              -- '2026-02-24'
  date_out,             -- null
  created_at,           -- NOW()
  updated_at            -- NOW()
) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW());
```

**Handling:**
- **Kalau BERHASIL INSERT:**
  
  → Lanjut ke Step 7.6

- **Kalau GAGAL INSERT:**
  
  **Log:**
  ```
  [2026-02-24 10:00:02] ❌ Failed to insert data ID: 385
  Error details: duplicate key value violates unique constraint...
  ```
  
  → Counter: `skippedCount++`
  → Lanjut ke record berikutnya
  → **TIDAK STOP seluruh sync** (hanya skip record ini)

---

#### **STEP 7.6: CATAT DI sync_records (PREVENT DUPLICATE)**

**Function:** `recordSynced()`

**Proses:**
```sql
INSERT INTO sync_records (sync_name, source_id, synced_at)
VALUES ('inventory_stock', 385, NOW())
ON CONFLICT (sync_name, source_id) DO NOTHING;
```

**Tujuan:**
- Catat bahwa MySQL id=385 sudah pernah di-sync
- Kalau nanti sync jalan lagi, id=385 akan di-SKIP (lihat Step 7.1)

**Handling Error:**
- Kalau gagal insert → Log error, tapi **tetap anggap berhasil sync**

---

#### **STEP 7.7: LOG SUKSES**

**Log yang muncul:**
```
[2026-02-24 10:00:02] ℹ️  ✅ Inserted NEW row for MySQL ID: 385 | WHS: WH-LOKAL | Part: ABC123
```

→ Counter: `successCount++`
→ Update: `lastProcessedId = 385`

---

### ═════════ **ULANGI STEP 7.1 - 7.7 untuk Record Berikutnya** ═════════

Proses untuk record id=386, id=387, dst...

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 8: UPDATE SYNC STATE (SUKSES)
### ═══════════════════════════════════════════════════════════════

**File:** `src/services/syncState.service.js` → Function `updateSyncSuccess()`

**Proses:**
```sql
UPDATE sync_state
SET 
  last_sync_id = 387,           -- ID terakhir yang di-proses
  last_run_at = NOW(),
  status = 'success',
  error_message = NULL,
  updated_at = NOW()
WHERE sync_name = 'inventory_stock';
```

**Tujuan:**
- Update progress (next sync akan mulai dari id > 387)
- Tandai status = 'success'
- Clear error_message kalau ada

**Log yang muncul:**
```
[2026-02-24 10:00:02] ✅ Sync state updated: inventory_stock | Last ID: 387 | Records: 2
```

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 9: RELEASE KONEKSI PostgreSQL
### ═══════════════════════════════════════════════════════════════

**Proses:**
```javascript
connection.release();
```

**Tujuan:**
- Kembalikan koneksi ke pool
- Koneksi bisa dipakai oleh proses lain

**Kapan:**
- Dijalankan di block `finally` → **SELALU dijalankan** (sukses atau gagal)

---

### ═══════════════════════════════════════════════════════════════
### 📌 TAHAP 10: LOG HASIL AKHIR (SUKSES)
### ═══════════════════════════════════════════════════════════════

**Log yang muncul:**
```
[2026-02-24 10:00:02] ✅ Sync completed successfully in 1.23s
[2026-02-24 10:00:02] ℹ️  Synced: 2 | Skipped: 1 | Last ID: 387
[2026-02-24 10:00:02] 🔄 ==========================================
```

**Data yang di-return:**
```javascript
{
  success: true,
  synced: 2,      // Berhasil insert 2 record
  skipped: 1      // Skip 1 record (sudah pernah sync atau data tidak valid)
}
```

**Set flag:**
```javascript
isRunning = false;  // Sync selesai, bisa jalankan sync berikutnya
```

---

---

## ❌ HANDLING KALAU GAGAL

### ═══════════════════════════════════════════════════════════════
### 📌 SKENARIO GAGAL 1: ERROR SAAT QUERY MySQL
### ═══════════════════════════════════════════════════════════════

**Penyebab:**
- MySQL connection lost
- Query timeout
- Table tidak ada

**Proses:**
1. Throw error di `fetchNewDataFromMySQL()`
2. Catch error di `syncInventoryStock()` → block `catch`
3. **Update sync_state dengan status 'failed':**

```sql
UPDATE sync_state
SET 
  status = 'failed',
  error_message = 'Connection lost',
  updated_at = NOW()
WHERE sync_name = 'inventory_stock';
```

**Log yang muncul:**
```
[2026-02-24 10:00:01] ❌ Failed to fetch data from MySQL
Error details: Connection lost
[2026-02-24 10:00:01] ❌ Sync failed
[2026-02-24 10:00:01] 🔄 ==========================================
```

**Data yang di-return:**
```javascript
{
  success: false,
  error: 'Connection lost'
}
```

**Next:**
- `isRunning = false` (di block `finally`)
- Scheduler akan coba lagi di cycle berikutnya (2 menit lagi)
- **TIDAK STOP scheduler** (cron tetap jalan)

---

### ═══════════════════════════════════════════════════════════════
### 📌 SKENARIO GAGAL 2: ERROR SAAT INSERT PostgreSQL
### ═══════════════════════════════════════════════════════════════

**Penyebab:**
- Duplicate key constraint
- Foreign key constraint
- PostgreSQL connection lost

**Proses:**
1. Error terjadi di `upsertToPostgreSQL()`
2. Catch error di loop processing → **TIDAK throw error**
3. Log error untuk record tersebut
4. **Skip record ini** → `skippedCount++`
5. **Lanjut ke record berikutnya**

**Log yang muncul:**
```
[2026-02-24 10:00:02] ❌ Failed to insert data ID: 385
Error details: duplicate key value violates unique constraint...
[2026-02-24 10:00:02] ❌ Error processing record ID 385
```

**Hasil:**
- Record lain tetap di-proses (tidak berhenti)
- Sync state tetap update dengan `last_sync_id = 387`
- Status = 'success' (karena sync tetap jalan, hanya sebagian skip)

**Counter:**
```
Synced: 2
Skipped: 1 (record ID 385 yang error)
```

---

### ═══════════════════════════════════════════════════════════════
### 📌 SKENARIO GAGAL 3: ERROR DI TENGAH PROSES
### ═══════════════════════════════════════════════════════════════

**Penyebab:**
- PostgreSQL connection timeout saat processing
- Out of memory
- Unexpected error

**Proses:**
1. Error throw di dalam loop
2. Catch di `syncInventoryStock()` → block `catch`
3. Update sync_state dengan status 'failed'
4. Release connection (di block `finally`)

**Log yang muncul:**
```
[2026-02-24 10:00:02] ❌ Sync failed
Error details: Connection timeout
[2026-02-24 10:00:02] 🔄 ==========================================
```

**Hasil:**
- Sync berhenti di tengah
- `last_sync_id` tetap di nilai terakhir yang berhasil
- Status = 'failed'
- Next cycle akan retry dari `last_sync_id` yang tersimpan

---

---

## 📊 SUMMARY FLOW DIAGRAM

```
┌─────────────────────────────────────────────────────────────┐
│ SCHEDULER (Setiap 2 Menit)                                  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
         ┌─────────────────────────┐
         │ isRunning?              │
         └─────┬──────────────┬────┘
               │ YES          │ NO
               │              │
         ┌─────▼─────┐        │
         │ SKIP      │        │
         └───────────┘        │
                              │
                              ▼
         ┌────────────────────────────────────────┐
         │ SET isRunning = true                   │
         │ SET status = 'running'                 │
         └──────────────┬─────────────────────────┘
                        │
                        ▼
         ┌─────────────────────────────┐
         │ GET last_sync_id            │
         │ (misal: 384)                │
         └──────────┬──────────────────┘
                    │
                    ▼
         ┌─────────────────────────────────────┐
         │ QUERY MySQL:                        │
         │ SELECT * FROM inventory_stock       │
         │ WHERE id > 384                      │
         │ ORDER BY id ASC LIMIT 5             │
         └──────────┬──────────────────────────┘
                    │
         ┌──────────▼────────────┐
         │ Ada data baru?        │
         └──┬────────────────┬───┘
            │ NO             │ YES
            │                │
    ┌───────▼──────┐         │
    │ UPDATE       │         │
    │ sync_state   │         │
    │ success      │         │
    │ SELESAI      │         │
    └──────────────┘         │
                             ▼
         ┌──────────────────────────────────────┐
         │ LOOP setiap record:                  │
         │                                      │
         │  ┌──────────────────────────────┐    │
         │  │ 1. Cek sync_records          │    │
         │  │    Sudah pernah sync?        │    │
         │  └────┬──────────────────┬──────┘    │
         │       │ YES              │ NO         │
         │  ┌────▼─────┐            │            │
         │  │ SKIP     │            │            │
         │  └──────────┘            │            │
         │                          ▼            │
         │  ┌──────────────────────────────┐    │
         │  │ 2. Lookup warehouse_area_id  │    │
         │  │    (dari whs_code)           │    │
         │  └────┬──────────────────┬──────┘    │
         │       │ TIDAK DAPAT      │ DAPAT     │
         │  ┌────▼─────┐            │            │
         │  │ SKIP     │            │            │
         │  └──────────┘            │            │
         │                          ▼            │
         │  ┌──────────────────────────────┐    │
         │  │ 3. Lookup item_id            │    │
         │  │    (dari part_number)        │    │
         │  └────┬──────────────────┬──────┘    │
         │       │ TIDAK DAPAT      │ DAPAT     │
         │  ┌────▼─────┐            │            │
         │  │ SKIP     │            │            │
         │  └──────────┘            │            │
         │                          ▼            │
         │  ┌──────────────────────────────┐    │
         │  │ 4. INSERT inventory_stocks   │    │
         │  └────┬──────────────────┬──────┘    │
         │       │ ERROR            │ SUKSES    │
         │  ┌────▼─────┐            │            │
         │  │ SKIP     │            │            │
         │  │ Log      │            │            │
         │  │ Error    │            │            │
         │  └──────────┘            │            │
         │                          ▼            │
         │  ┌──────────────────────────────┐    │
         │  │ 5. INSERT sync_records       │    │
         │  │    (catat MySQL ID)          │    │
         │  └────┬─────────────────────────┘    │
         │       │                               │
         │       ▼                               │
         │  ┌──────────────────────────────┐    │
         │  │ successCount++               │    │
         │  │ lastProcessedId = record.id  │    │
         │  └──────────────────────────────┘    │
         │                                      │
         └──────────────┬───────────────────────┘
                        │
                        ▼
         ┌──────────────────────────────────────┐
         │ UPDATE sync_state                    │
         │ - last_sync_id = lastProcessedId     │
         │ - status = 'success'                 │
         │ - last_run_at = NOW()                │
         └──────────────┬───────────────────────┘
                        │
                        ▼
         ┌──────────────────────────────────────┐
         │ RELEASE PostgreSQL connection        │
         │ SET isRunning = false                │
         └──────────────┬───────────────────────┘
                        │
                        ▼
         ┌──────────────────────────────────────┐
         │ ✅ LOG: Sync completed successfully  │
         │    Synced: X | Skipped: Y            │
         └──────────────────────────────────────┘
```

---

## 📋 CHECKLIST MONITORING

### ✅ Kalau Sync BERHASIL:
- [ ] Log menunjukkan "Sync completed successfully"
- [ ] `sync_state.status` = 'success'
- [ ] `sync_state.last_sync_id` bertambah
- [ ] `sync_state.last_run_at` updated
- [ ] Table `inventory_stocks` bertambah data
- [ ] Table `sync_records` bertambah entries

### ❌ Kalau Sync GAGAL:
- [ ] Log menunjukkan "Sync failed"
- [ ] `sync_state.status` = 'failed'
- [ ] `sync_state.error_message` terisi
- [ ] `sync_state.last_sync_id` tetap (tidak berubah)
- [ ] Scheduler tetap jalan (akan retry di cycle berikutnya)

### ⚠️ Kalau Ada Record yang Di-SKIP:
- [ ] Log menunjukkan "skipping record ID: XXX"
- [ ] `skippedCount` bertambah
- [ ] Sync tetap lanjut (tidak berhenti)
- [ ] `last_sync_id` tetap update ke ID terakhir yang di-proses

---

## 🔍 QUERY MONITORING

### Cek status sync terakhir:
```sql
SELECT * FROM sync_state WHERE sync_name = 'inventory_stock';
```

### Cek berapa MySQL IDs yang sudah di-sync:
```sql
SELECT COUNT(*) FROM sync_records WHERE sync_name = 'inventory_stock';
```

### Cek MySQL IDs terakhir yang di-sync:
```sql
SELECT source_id, synced_at 
FROM sync_records 
WHERE sync_name = 'inventory_stock'
ORDER BY synced_at DESC 
LIMIT 10;
```

### Cek data yang baru masuk PostgreSQL:
```sql
SELECT * FROM inventory_stocks 
ORDER BY created_at DESC 
LIMIT 10;
```

---

**📌 Catatan Penting:**
- Sync berjalan **setiap 2 menit** otomatis
- Setiap sync hanya ambil **5 record** (configurable via SYNC_BATCH_SIZE)
- Data yang **sudah pernah di-sync tidak akan di-insert lagi** (tracked via sync_records)
- Kalau ada error di 1 record, **sync tetap lanjut** untuk record lainnya
- Kalau ada error kritis (MySQL down), sync akan **retry di cycle berikutnya**

