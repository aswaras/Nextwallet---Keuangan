/**
 * NEXWALLET BACKEND — Google Apps Script + Google Sheets sebagai Database
 * ------------------------------------------------------------------------
 * CARA DEPLOY:
 * 1. Buka https://script.google.com -> New Project.
 * 2. Hapus isi default, tempel seluruh isi file ini.
 * 3. Jalankan fungsi `setup` sekali (pilih function "setup" di dropdown, klik Run).
 *    - Akan meminta izin akses Spreadsheet & Drive, klik Allow.
 *    - Ini akan otomatis membuat Google Spreadsheet baru bernama "NexWallet Database"
 *      berikut semua sheet (Wallets, Transactions, Debts, Settings) beserta header.
 * 4. Deploy -> New deployment -> Type: Web app.
 *    - Execute as: Me
 *    - Who has access: Anyone
 * 5. Copy URL Web App yang diberikan (contoh: https://script.google.com/macros/s/xxxx/exec)
 * 6. Tempel URL tersebut ke CONFIG.API_URL di file index.html (frontend).
 */

// ================== KONFIGURASI ==================
const SHEET_NAMES = {
  WALLETS: 'Wallets',
  TRANSACTIONS: 'Transactions',
  DEBTS: 'Debts',
  SETTINGS: 'Settings'
};

const HEADERS = {
  Wallets: ['id', 'name', 'type', 'balance', 'color', 'icon', 'createdAt', 'updatedAt'],
  Transactions: ['id', 'type', 'amount', 'category', 'walletId', 'date', 'time', 'desc', 'photoUrl', 'createdAt', 'updatedAt'],
  Debts: ['id', 'name', 'type', 'amount', 'originalAmount', 'status', 'dueDate', 'note', 'createdAt', 'updatedAt'],
  Settings: ['key', 'value']
};

const DRIVE_FOLDER_NAME = 'NexWallet Receipts';

// ================== SETUP (jalankan sekali secara manual) ==================
function setup() {
  const ss = getOrCreateSpreadsheet();
  Object.keys(HEADERS).forEach(function (name) {
    ensureSheet(ss, name, HEADERS[name]);
  });

  // Seed default settings kalau belum ada
  const settingsSheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  const settings = objectsFromSheet(settingsSheet);
  const existingKeys = settings.map(function (s) { return s.key; });
  const defaults = {
    userName: 'Pengguna Baru',
    pinHash: '',
    themeColor: 'blue',
    darkMode: 'false',
    currency: 'IDR'
  };
  Object.keys(defaults).forEach(function (k) {
    if (existingKeys.indexOf(k) === -1) {
      settingsSheet.appendRow([k, defaults[k]]);
    }
  });

  Logger.log('Setup selesai. Spreadsheet ID: ' + ss.getId());
  Logger.log('Spreadsheet URL: ' + ss.getUrl());
}

function getOrCreateSpreadsheet() {
  const props = PropertiesService.getScriptProperties();
  let id = props.getProperty('SPREADSHEET_ID');
  if (id) {
    try {
      return SpreadsheetApp.openById(id);
    } catch (e) {
      // fallthrough to create new
    }
  }
  const ss = SpreadsheetApp.create('NexWallet Database');
  props.setProperty('SPREADSHEET_ID', ss.getId());
  return ss;
}

function ensureSheet(ss, name, headers) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
  }
  const firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const isEmpty = firstRow.every(function (v) { return v === ''; });
  if (isEmpty) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  }
  return sheet;
}

// ================== ENTRY POINTS ==================
function doOptions(e) {
  return ContentService.createTextOutput('');
}

function doGet(e) {
  try {
    const action = (e && e.parameter && e.parameter.action) || 'getAll';
    if (action === 'getAll') {
      return jsonResponse({ ok: true, data: getAllData() });
    }
    return jsonResponse({ ok: false, error: 'Unknown GET action: ' + action });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    const action = body.action;
    const payload = body.payload || {};
    const result = routeAction(action, payload);
    return jsonResponse({ ok: true, data: result });
  } catch (err) {
    return jsonResponse({ ok: false, error: String(err) });
  }
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function routeAction(action, payload) {
  const ss = getOrCreateSpreadsheet();
  switch (action) {
    case 'getAll': return getAllData();

    case 'addWallet': return addRow(ss, SHEET_NAMES.WALLETS, payload);
    case 'updateWallet': return updateRow(ss, SHEET_NAMES.WALLETS, payload);
    case 'deleteWallet': return deleteRow(ss, SHEET_NAMES.WALLETS, payload.id);

    case 'addTransaction': return addTransaction(ss, payload);
    case 'updateTransaction': return updateTransaction(ss, payload);
    case 'deleteTransaction': return deleteTransaction(ss, payload);

    case 'addDebt': return addRow(ss, SHEET_NAMES.DEBTS, payload);
    case 'updateDebt': return updateRow(ss, SHEET_NAMES.DEBTS, payload);
    case 'deleteDebt': return deleteRow(ss, SHEET_NAMES.DEBTS, payload.id);
    case 'payDebt': return payDebt(ss, payload);

    case 'updateSettings': return updateSettings(ss, payload);

    case 'uploadReceipt': return uploadReceipt(payload);

    case 'restoreData': return restoreData(ss, payload);

    default: throw new Error('Unknown action: ' + action);
  }
}

// ================== GENERIC SHEET HELPERS ==================
function objectsFromSheet(sheet) {
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0];
  const rows = values.slice(1);
  return rows
    .filter(function (r) { return r.some(function (c) { return c !== ''; }); })
    .map(function (r) {
      const obj = {};
      headers.forEach(function (h, i) { obj[h] = r[i]; });
      return obj;
    });
}

function findRowIndexById(sheet, id) {
  const values = sheet.getDataRange().getValues();
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(id)) return i + 1; // 1-indexed row
  }
  return -1;
}

function addRow(ss, sheetName, payload) {
  const sheet = ss.getSheetByName(sheetName);
  const headers = HEADERS[sheetName];
  const now = new Date().toISOString();
  payload.id = payload.id || Utilities.getUuid();
  payload.createdAt = payload.createdAt || now;
  payload.updatedAt = now;
  const row = headers.map(function (h) { return payload[h] !== undefined ? payload[h] : ''; });
  sheet.appendRow(row);
  return payload;
}

function updateRow(ss, sheetName, payload) {
  const sheet = ss.getSheetByName(sheetName);
  const headers = HEADERS[sheetName];
  const rowIndex = findRowIndexById(sheet, payload.id);
  if (rowIndex === -1) throw new Error('Row not found: ' + payload.id);
  payload.updatedAt = new Date().toISOString();
  const existing = {};
  const existingValues = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  headers.forEach(function (h, i) { existing[h] = existingValues[i]; });
  const merged = Object.assign({}, existing, payload);
  const row = headers.map(function (h) { return merged[h] !== undefined ? merged[h] : ''; });
  sheet.getRange(rowIndex, 1, 1, headers.length).setValues([row]);
  return merged;
}

function deleteRow(ss, sheetName, id) {
  const sheet = ss.getSheetByName(sheetName);
  const rowIndex = findRowIndexById(sheet, id);
  if (rowIndex === -1) throw new Error('Row not found: ' + id);
  sheet.deleteRow(rowIndex);
  return { id: id, deleted: true };
}

// ================== DATA AGGREGATE ==================
function getAllData() {
  const ss = getOrCreateSpreadsheet();
  const wallets = objectsFromSheet(ss.getSheetByName(SHEET_NAMES.WALLETS));
  const transactions = objectsFromSheet(ss.getSheetByName(SHEET_NAMES.TRANSACTIONS));
  const debts = objectsFromSheet(ss.getSheetByName(SHEET_NAMES.DEBTS));
  const settingsRows = objectsFromSheet(ss.getSheetByName(SHEET_NAMES.SETTINGS));
  const settings = {};
  settingsRows.forEach(function (r) { settings[r.key] = r.value; });
  return { wallets: wallets, transactions: transactions, debts: debts, settings: settings, serverTime: new Date().toISOString() };
}

// ================== TRANSACTIONS (juga update saldo dompet) ==================
function addTransaction(ss, payload) {
  const trx = addRow(ss, SHEET_NAMES.TRANSACTIONS, payload);
  adjustWalletBalance(ss, trx.walletId, trx.type === 'income' ? Number(trx.amount) : -Number(trx.amount));
  return trx;
}

function updateTransaction(ss, payload) {
  const sheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const rowIndex = findRowIndexById(sheet, payload.id);
  if (rowIndex === -1) throw new Error('Transaction not found: ' + payload.id);
  const headers = HEADERS.Transactions;
  const oldValues = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  const old = {};
  headers.forEach(function (h, i) { old[h] = oldValues[i]; });

  // Revert old balance effect
  adjustWalletBalance(ss, old.walletId, old.type === 'income' ? -Number(old.amount) : Number(old.amount));

  const updated = updateRow(ss, SHEET_NAMES.TRANSACTIONS, payload);

  // Apply new balance effect
  adjustWalletBalance(ss, updated.walletId, updated.type === 'income' ? Number(updated.amount) : -Number(updated.amount));

  return updated;
}

function deleteTransaction(ss, payload) {
  const sheet = ss.getSheetByName(SHEET_NAMES.TRANSACTIONS);
  const rowIndex = findRowIndexById(sheet, payload.id);
  if (rowIndex === -1) throw new Error('Transaction not found: ' + payload.id);
  const headers = HEADERS.Transactions;
  const values = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  const trx = {};
  headers.forEach(function (h, i) { trx[h] = values[i]; });

  adjustWalletBalance(ss, trx.walletId, trx.type === 'income' ? -Number(trx.amount) : Number(trx.amount));
  sheet.deleteRow(rowIndex);
  return { id: payload.id, deleted: true };
}

function adjustWalletBalance(ss, walletId, delta) {
  if (!walletId) return;
  const sheet = ss.getSheetByName(SHEET_NAMES.WALLETS);
  const rowIndex = findRowIndexById(sheet, walletId);
  if (rowIndex === -1) return;
  const headers = HEADERS.Wallets;
  const balanceCol = headers.indexOf('balance') + 1;
  const current = Number(sheet.getRange(rowIndex, balanceCol).getValue()) || 0;
  sheet.getRange(rowIndex, balanceCol).setValue(current + delta);
}

// ================== DEBTS ==================
function payDebt(ss, payload) {
  // payload: { id, payAmount, walletId (optional, to log transaction) }
  const sheet = ss.getSheetByName(SHEET_NAMES.DEBTS);
  const rowIndex = findRowIndexById(sheet, payload.id);
  if (rowIndex === -1) throw new Error('Debt not found: ' + payload.id);
  const headers = HEADERS.Debts;
  const values = sheet.getRange(rowIndex, 1, 1, headers.length).getValues()[0];
  const debt = {};
  headers.forEach(function (h, i) { debt[h] = values[i]; });

  const payAmount = Number(payload.payAmount) || 0;
  const remaining = Math.max(0, Number(debt.amount) - payAmount);
  const status = remaining === 0 ? 'Lunas' : 'Sebagian';

  const updated = updateRow(ss, SHEET_NAMES.DEBTS, { id: payload.id, amount: remaining, status: status });

  if (payload.walletId) {
    const trxType = debt.type === 'piutang' ? 'income' : 'expense';
    addTransaction(ss, {
      type: trxType,
      amount: payAmount,
      category: debt.type === 'piutang' ? 'Pembayaran Piutang' : 'Bayar Hutang',
      walletId: payload.walletId,
      date: payload.date || Utilities.formatDate(new Date(), 'GMT+7', 'yyyy-MM-dd'),
      time: payload.time || Utilities.formatDate(new Date(), 'GMT+7', 'HH:mm'),
      desc: 'Pembayaran: ' + debt.name
    });
  }

  return updated;
}

// ================== SETTINGS ==================
function updateSettings(ss, payload) {
  const sheet = ss.getSheetByName(SHEET_NAMES.SETTINGS);
  const values = sheet.getDataRange().getValues();
  const keyToRow = {};
  for (let i = 1; i < values.length; i++) keyToRow[values[i][0]] = i + 1;

  Object.keys(payload).forEach(function (key) {
    if (keyToRow[key]) {
      sheet.getRange(keyToRow[key], 2).setValue(payload[key]);
    } else {
      sheet.appendRow([key, payload[key]]);
    }
  });
  return payload;
}

// ================== RECEIPT UPLOAD (Google Drive) ==================
function uploadReceipt(payload) {
  // payload: { base64, fileName, mimeType }
  const folder = getOrCreateFolder(DRIVE_FOLDER_NAME);
  const bytes = Utilities.base64Decode(payload.base64.split(',').pop());
  const blob = Utilities.newBlob(bytes, payload.mimeType || 'image/jpeg', payload.fileName || ('receipt_' + Date.now() + '.jpg'));
  const file = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { url: 'https://drive.google.com/uc?id=' + file.getId() };
}

function getOrCreateFolder(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}

// ================== BACKUP / RESTORE ==================
function restoreData(ss, payload) {
  // payload: { wallets: [], transactions: [], debts: [], settings: {} }
  ['Wallets', 'Transactions', 'Debts'].forEach(function (name) {
    const sheet = ss.getSheetByName(SHEET_NAMES[name.toUpperCase()]);
    const lastRow = sheet.getLastRow();
    if (lastRow > 1) sheet.deleteRows(2, lastRow - 1);
  });

  (payload.wallets || []).forEach(function (w) { appendExact(ss.getSheetByName(SHEET_NAMES.WALLETS), HEADERS.Wallets, w); });
  (payload.transactions || []).forEach(function (t) { appendExact(ss.getSheetByName(SHEET_NAMES.TRANSACTIONS), HEADERS.Transactions, t); });
  (payload.debts || []).forEach(function (d) { appendExact(ss.getSheetByName(SHEET_NAMES.DEBTS), HEADERS.Debts, d); });

  if (payload.settings) updateSettings(ss, payload.settings);

  return { restored: true };
}

function appendExact(sheet, headers, obj) {
  const row = headers.map(function (h) { return obj[h] !== undefined ? obj[h] : ''; });
  sheet.appendRow(row);
}
