// ========================================
// KONFIGURASI — EDIT BAGIAN INI
// ========================================
const SHEET_NAME = 'Donasi';
const CASH_SHEET_NAME = 'Buku Kas';
const PROOF_FOLDER_NAME = 'Bukti Transfer Donasi';

// PIN Admin dan email Bendahara TIDAK ditaruh di sini sebagai teks biasa.
// Simpan lewat: ikon gerigi "Project Settings" di kiri > scroll ke
// "Script Properties" > Add script property
// - Nama: ADMIN_PIN         Nilai: (bebas, contoh: 4 digit angka)
// - Nama: BENDAHARA_EMAIL   Nilai: alamat Gmail yang dipakai Bendahara
//   (dipakai supaya bukti transfer HANYA bisa dibuka akun ini — orang lain
//   yang kebetulan dapat link akan diminta "Request Access" oleh Google,
//   bukan langsung bisa lihat)

// ----- Beranda publik (transparansi keuangan) -----
const PUBLIC_PAGE_SIZE = 20;          // jumlah entri riwayat per "Tampilkan lebih banyak"
const PUBLIC_CACHE_SECONDS = 300;     // data publik disimpan sementara maksimal 5 menit
const PUBLIC_CACHE_PREFIX = 'pub_v2_';

// ----- Batas keamanan (boleh disesuaikan) -----
const MIN_DONATION = 1000;
const MAX_DONATION = 50000000;            // donasi lebih besar: Bendahara catat manual lewat Buku Kas
const MAX_PROOF_BASE64_CHARS = 7000000;   // ~5 MB
const ALLOWED_PROOF_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
const MAX_SUBMITS_PER_HOUR = 120;         // batas GLOBAL kiriman bukti, cegah spam
const MAX_SUBMITS_PER_DAY = 400;
const PIN_MAX_FAILS = 8;                  // PIN salah berturut-turut sebelum admin dikunci
const PIN_LOCK_SECONDS = 600;             // lama kunci (10 menit)
const LOG_SHEET_NAME = 'Log Admin';
const BACKUP_FOLDER_NAME = 'Backup Keuangan Masjid';
const BACKUP_KEEP = 8;                    // jumlah backup mingguan yang disimpan
const VOID_STATUS = 'Dibatalkan';

// ----- Sesi admin (token acak di sisi server; PIN TIDAK pernah disimpan di browser) -----
const SESSION_IDLE_SECONDS = 900;         // sesi habis 15 menit setelah aktivitas terakhir
const SESSION_MAX_SECONDS = 14400;        // batas mutlak 4 jam sejak masuk, seaktif apa pun

// ----- Kode unik donasi (supaya tiap bukti pending punya nominal berbeda -> cocok 1:1 ke mutasi) -----
const UNIQUE_CODE_MAX = 999;              // kode 1..999 ditambahkan ke nominal dasar
const RESERVE_TTL_SECONDS = 21600;        // reservasi kode berlaku 6 jam (batas maksimum CacheService)
const MAX_RESERVE_PER_HOUR = 100;         // batas global, cegah kehabisan kode oleh spam
const UNIQUE_LOOKBACK_DAYS = 45;          // hindari nominal yang sama dengan donasi 45 hari terakhir

// ----- Rekonsiliasi saldo rekening bank vs saldo buku -----
const REKON_SHEET_NAME = 'Rekonsiliasi';
const REKON_HEADERS = ['Waktu Input', 'Tanggal Saldo', 'Saldo Rekening', 'Kas Tunai', 'Saldo Buku', 'Donasi Menunggu', 'Selisih', 'Catatan', 'ID'];

let _sessionOk = false;                   // true hanya jika request membawa token sesi yang sah
let _ledgerWarnings = [];                 // temuan data janggal di Sheet (dibaca admin)

const DONATION_CATEGORY_LABELS = {
  'infaq': 'Infaq',
  'pembangunan': 'Pembangunan',
  'sedekah-jumat': "Sedekah Jum'at",
  'maulid-nabi': 'Maulid Nabi SAW'
};
// Kategori yang boleh dipilih Bendahara saat mencatat transaksi manual.
const INCOME_CATEGORIES = ['Kotak Amal', 'Infaq', 'Pembangunan', "Sedekah Jum'at", 'Maulid Nabi SAW', 'Lainnya'];
const EXPENSE_CATEGORIES = ['Operasional', 'Pembangunan', 'Maulid Nabi SAW', "Sedekah Jum'at", 'Lainnya'];

const SALDO_AWAL_CATEGORY = 'Saldo Awal';
const ANON_NAME = 'Hamba Allah';
const INCOME_VERIFIED = 'Terverifikasi';
const INCOME_PENDING = 'Menunggu Verifikasi';
const EXPENSE_PAID = 'Sudah Dibayar';
const EXPENSE_PLANNED = 'Direncanakan';

// Susunan kolom (urutan kolom TIDAK boleh diubah manual di Sheet)
// Sheet "Donasi":    A Waktu Kirim | B Order ID | C Kategori | D Nominal | E Nama Pengirim | F No HP |
//                    G Link Bukti | H Status | I Waktu Verifikasi | J Catatan | K Nama Tampil (baru)
// Sheet "Buku Kas":  A Waktu | B Tipe | C Keterangan | D Nominal |
//                    E Kategori (baru) | F Penerima (baru) | G Status (baru) | H ID Entri (baru)
const DONASI_HEADERS = ['Waktu Kirim', 'Order ID', 'Kategori', 'Nominal', 'Nama Pengirim', 'No HP', 'Link Bukti', 'Status', 'Waktu Verifikasi', 'Catatan', 'Nama Tampil', 'Kode Unik'];
const KAS_HEADERS = ['Waktu', 'Tipe', 'Keterangan', 'Nominal', 'Kategori', 'Penerima', 'Status', 'ID Entri'];

// ========================================
// ROUTER UTAMA — menerima semua request POST
// ========================================
function doPost(e) {
  let result;
  try {
    const data = JSON.parse(e.postData.contents);

    // --- Sesi admin: login memberi token; aksi admin berikutnya cukup membawa token ---
    _sessionOk = false;
    if (data.action === 'login') {
      return jsonOut(loginAdmin(data.pin));
    }
    if (data.action === 'logout') {
      return jsonOut(logoutAdmin(data.token));
    }
    if (data.token) {
      if (!checkSession(data.token)) {
        return jsonOut({ success: false, sessionExpired: true, message: 'Sesi berakhir. Silakan masuk lagi.' });
      }
      _sessionOk = true;
    }

    if (data.action === 'submitDonationProof') {
      // Donatur mengirim bukti transfer (foto + metadata)
      result = submitDonationProof(data.category, data.amount, data.donorName, data.donorPhone, data.proofBase64, data.proofMimeType, data.proofFileName, data.reservationId);
    } else if (data.action === 'reserveDonationAmount') {
      // Donatur meminta nominal transfer + kode unik SEBELUM transfer
      result = reserveDonationAmount(data.category, data.baseAmount);
    } else if (data.action === 'catatSaldoBank') {
      // Bendahara mencatat saldo rekening BSI (+ kas tunai) per tanggal tertentu
      result = catatSaldoBank(data.pin, data.tanggal, data.saldoBank, data.kasTunai, data.catatan);
    } else if (data.action === 'getPublicOverview') {
      // PUBLIK (tanpa PIN, hanya-baca): ringkasan dana + rincian per kategori
      result = getPublicOverview();
    } else if (data.action === 'getPublicHistory') {
      // PUBLIK (tanpa PIN, hanya-baca): riwayat pemasukan/pengeluaran, bertahap
      result = getPublicHistory(data.type, data.offset);
    } else if (data.action === 'ping') {
      // Penjaga sesi: panel admin memanggil ini berkala selagi Bendahara aktif mengisi formulir
      result = _sessionOk ? { success: true } : { success: false, sessionExpired: true, message: 'Perlu masuk' };
    } else if (data.action === 'getLedgerData') {
      // Panel admin meminta seluruh data buku kas (yang sudah terverifikasi)
      result = getLedgerData(data.pin);
    } else if (data.action === 'getPendingVerifications') {
      // Panel admin meminta daftar bukti transfer yang menunggu verifikasi
      result = getPendingVerifications(data.pin);
    } else if (data.action === 'confirmDonation') {
      // Bendahara mengonfirmasi bukti transfer sebagai valid
      result = confirmDonation(data.pin, data.orderId);
    } else if (data.action === 'rejectDonation') {
      // Bendahara menolak bukti transfer (tidak valid/tidak cocok)
      result = rejectDonation(data.pin, data.orderId, data.reason);
    } else if (data.action === 'hideDonorName') {
      // Bendahara menyamarkan nama tampil donatur menjadi "Hamba Allah"
      result = hideDonorName(data.pin, data.orderId);
    } else if (data.action === 'addManualEntry') {
      // Panel admin menambah entri manual (kotak amal, pengeluaran, dll)
      result = addManualEntry(data.pin, data.tipe, data.keterangan, data.nominal, data.kategori, data.penerima, data.status, data.tanggal);
    } else if (data.action === 'markExpensePaid') {
      // Bendahara menandai pengeluaran "Direncanakan" menjadi "Sudah Dibayar"
      result = markExpensePaid(data.pin, data.entryId, data.tanggal);
    } else if (data.action === 'addSaldoAwal') {
      // Bendahara mencatat Saldo Awal sistem (sekali saja)
      result = addSaldoAwal(data.pin, data.tanggal, data.nominal);
    } else if (data.action === 'reopenDonation') {
      // Bendahara membatalkan keputusan (salah pencet): kembali ke "menunggu verifikasi"
      result = reopenDonation(data.pin, data.orderId);
    } else if (data.action === 'voidEntry') {
      // Bendahara membatalkan entri Buku Kas yang salah input (tidak dihapus, hanya ditandai)
      result = voidEntry(data.pin, data.entryId, data.reason);
    } else if (data.action === 'generateReport') {
      // Panel admin meminta laporan periode tertentu
      result = generateReport(data.pin, data.startDate, data.endDate);
    } else {
      result = { success: false, message: 'Aksi tidak dikenali' };
    }
  } catch (err) {
    console.error(err);
    result = { success: false, message: 'Server sedang sibuk atau terjadi kesalahan. Silakan coba lagi.' };
  }

  return jsonOut(result);
}

function jsonOut(result) {
  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// Buka URL deployment ini langsung di browser untuk mengecek server aktif atau tidak.
// Data PUBLIK (hanya-baca) juga bisa diambil lewat GET, jadi frontend tidak perlu
// POST + trik Content-Type untuk menghindari CORS preflight:
//   ...exec?action=getPublicOverview
//   ...exec?action=getPublicHistory&type=income&offset=0   (type: income | expense)
function doGet(e) {
  const p = (e && e.parameter) || {};
  let result = { status: 'Server aktif dan siap' };
  try {
    if (p.action === 'getPublicOverview') {
      result = getPublicOverview();
    } else if (p.action === 'getPublicHistory') {
      result = getPublicHistory(p.type, p.offset);
    }
  } catch (err) {
    console.error(err);
    result = { success: false, message: 'Server sedang sibuk atau terjadi kesalahan. Silakan coba lagi.' };
  }
  return jsonOut(result);
}

// ========================================
// PEMBERSIH TEKS (nama donatur, keterangan, penerima)
// ========================================
// Teks dari pengguna kini tampil di halaman publik, jadi dibersihkan saat
// disimpan: karakter kontrol & karakter pembalik arah teks dibuang, tanda < >
// dibuang, dan awalan = + - @ dibuang agar tidak dibaca Google Sheets sebagai
// rumus. (Tampilan di browser tetap memakai teks biasa, bukan HTML.)
function cleanText(value, maxLen) {
  let s = String(value === null || value === undefined ? '' : value);
  s = s.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u2028-\u202E\u2066-\u2069]/g, ' ');
  s = s.replace(/[<>]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/^[=+\-@\s]+/, '');
  if (s.length > maxLen) s = s.substring(0, maxLen).trim();
  return s;
}

// Nama donatur: hanya huruf, angka, spasi, dan tanda baca nama yang wajar;
// maksimal 40 karakter; kosong => "Hamba Allah".
function sanitizeDonorName(value) {
  let s = cleanText(value, 200);
  s = s.replace(/[^\p{L}\p{N} .,'\u2019()\/&-]/gu, '');
  s = s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
  if (s.length > 40) s = s.substring(0, 40).trim();
  return s || ANON_NAME;
}

function parseAmount(value) {
  const n = Number(value);
  return (isFinite(n) && n > 0 && n <= 1000000000000) ? Math.round(n) : 0;
}

// ========================================
// DONASI — TERIMA BUKTI TRANSFER DARI DONATUR
// ========================================
// Catatan penting: tidak ada payment gateway di alur ini. Donatur transfer
// manual ke rekening/QRIS BSI masjid, lalu upload bukti transfer di sini.
// Status transaksi TIDAK pernah otomatis "berhasil" — selalu dimulai dari
// 'menunggu_verifikasi' dan baru berubah setelah Bendahara mengecek manual
// ke mutasi rekening asli dan menekan tombol Konfirmasi/Tolak di panel admin.
function submitDonationProof(category, amount, donorName, donorPhone, proofBase64, proofMimeType, proofFileName, reservationId) {
  const amountNum = parseAmount(amount);
  if (!amountNum) {
    return { success: false, message: 'Nominal tidak valid' };
  }
  if (amountNum < MIN_DONATION) {
    return { success: false, message: 'Nominal minimal Rp ' + fmtRp(MIN_DONATION) };
  }
  if (amountNum > MAX_DONATION) {
    return { success: false, message: 'Nominal terlalu besar untuk formulir ini (maksimal Rp ' + fmtRp(MAX_DONATION) + '). Silakan hubungi pengurus masjid.' };
  }
  if (!DONATION_CATEGORY_LABELS[category]) {
    return { success: false, message: 'Kategori donasi tidak valid' };
  }
  if (!proofBase64 || !proofMimeType) {
    return { success: false, message: 'Bukti transfer belum dilampirkan' };
  }
  const mime = String(proofMimeType).toLowerCase().trim();
  if (ALLOWED_PROOF_MIME.indexOf(mime) === -1) {
    return { success: false, message: 'Bukti transfer harus berupa foto (JPG/PNG/WebP) atau PDF' };
  }
  if (String(proofBase64).length > MAX_PROOF_BASE64_CHARS) {
    return { success: false, message: 'Ukuran bukti transfer terlalu besar (maksimal sekitar 5 MB)' };
  }
  const limitMsg = checkSubmitLimits();
  if (limitMsg) {
    return { success: false, message: limitMsg };
  }

  // Kode unik hanya dianggap sah jika reservasinya masih berlaku DAN nominal + kategori
  // sama persis. Tanpa itu donasi TETAP diterima (uang sudah terlanjur ditransfer) tetapi
  // ditandai "tanpa kode unik" di panel Bendahara.
  let kodeUnik = '';
  let reservation = null;
  if (reservationId) {
    try {
      const raw = CacheService.getScriptCache().get('rsv_' + reservationId);
      const o = raw ? JSON.parse(raw) : null;
      if (o && o.total === amountNum && o.category === category) { kodeUnik = o.code; reservation = o; }
    } catch (e) { /* abaikan */ }
  }

  const orderId = category + '-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
  const displayName = sanitizeDonorName(donorName);

  let file;
  try {
    file = saveProofToDrive(proofBase64, mime, proofFileName, orderId);
  } catch (err) {
    console.error(err);
    return { success: false, message: 'Gagal menyimpan bukti transfer. Silakan coba lagi.' };
  }

  try {
    logDonation(orderId, category, amountNum, displayName, cleanText(donorPhone, 20), file.getUrl(), 'menunggu_verifikasi', kodeUnik);
  } catch (err) {
    // Jangan tinggalkan file yatim di Drive kalau pencatatan ke Sheet gagal.
    try { file.setTrashed(true); } catch (e) { /* abaikan */ }
    console.error(err);
    return { success: false, message: 'Sistem sedang sibuk, silakan coba kirim ulang.' };
  }
  if (reservation) {
    try {
      const cache = CacheService.getScriptCache();
      cache.remove('rsv_' + reservationId);
      cache.remove('rsv_amt_' + reservation.total);
    } catch (e) { /* abaikan */ }
  }
  clearPublicCache(); // supaya donasi baru langsung tampil sebagai "Menunggu Verifikasi"

  return { success: true, orderId: orderId, kodeUnik: kodeUnik };
}

// Langkah 1 alur donatur: minta nominal transfer. Nominal dasar + kode unik 1..999
// (mis. 50.000 -> 50.137) dijamin tidak sama dengan donasi pending/45 hari terakhir
// maupun reservasi aktif donatur lain. Kode unik ikut tercatat sebagai donasi.
function reserveDonationAmount(category, baseAmount) {
  const base = parseAmount(baseAmount);
  if (!base) return { success: false, message: 'Nominal tidak valid' };
  if (base < MIN_DONATION) return { success: false, message: 'Nominal minimal Rp ' + fmtRp(MIN_DONATION) };
  if (base > MAX_DONATION - UNIQUE_CODE_MAX) {
    return { success: false, message: 'Nominal terlalu besar untuk formulir ini (maksimal Rp ' + fmtRp(MAX_DONATION - UNIQUE_CODE_MAX) + '). Silakan hubungi pengurus masjid.' };
  }
  if (!DONATION_CATEGORY_LABELS[category]) return { success: false, message: 'Kategori donasi tidak valid' };

  const cache = CacheService.getScriptCache();
  const hourKey = 'reserve_h_' + Math.floor(Date.now() / 3600000);
  const h = Number(cache.get(hourKey) || 0);
  if (h >= MAX_RESERVE_PER_HOUR) {
    return { success: false, message: 'Sistem sedang ramai. Coba lagi beberapa saat lagi.' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const used = usedDonationAmounts();
    let code = 0, total = 0;
    for (let i = 0; i < 80; i++) {
      const c = 1 + Math.floor(Math.random() * UNIQUE_CODE_MAX);
      const t = base + c;
      if (!used[t] && !cache.get('rsv_amt_' + t)) { code = c; total = t; break; }
    }
    if (!code) {
      return { success: false, message: 'Belum bisa membuat kode unik saat ini. Coba lagi sebentar.' };
    }
    const id = 'R' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    cache.put('rsv_' + id, JSON.stringify({ total: total, code: code, category: category }), RESERVE_TTL_SECONDS);
    cache.put('rsv_amt_' + total, id, RESERVE_TTL_SECONDS);
    cache.put(hourKey, String(h + 1), 3700);
    return {
      success: true,
      reservationId: id,
      baseAmount: base,
      kodeUnik: code,
      totalAmount: total,
      berlakuMenit: Math.round(RESERVE_TTL_SECONDS / 60)
    };
  } finally {
    lock.releaseLock();
  }
}

// Nominal yang sudah "terpakai": semua donasi pending + donasi non-ditolak 45 hari terakhir.
function usedDonationAmounts() {
  const data = getSheet().getDataRange().getValues();
  const cutoff = Date.now() - UNIQUE_LOOKBACK_DAYS * 86400000;
  const used = {};
  for (let i = 1; i < data.length; i++) {
    const st = normStatus(data[i][7]);
    if (st === 'ditolak') continue;
    const t = new Date(data[i][0]).getTime();
    if (st === 'menunggu_verifikasi' || (isFinite(t) && t >= cutoff)) {
      const n = data[i][3];
      if (typeof n === 'number') used[n] = true;
    }
  }
  return used;
}

function fmtRp(n) {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

// Pembatas GLOBAL (tidak ada IP di Apps Script, jadi tidak bisa per-pengunjung).
// Tujuannya mencegah spam tanpa batas ke Drive/Sheet; tidak mengganggu donasi normal.
function checkSubmitLimits() {
  const cache = CacheService.getScriptCache();
  const hourKey = 'submits_h_' + Math.floor(Date.now() / 3600000);
  const dayKey = 'submits_d_' + Math.floor(Date.now() / 86400000);
  const h = Number(cache.get(hourKey) || 0);
  const d = Number(cache.get(dayKey) || 0);
  if (h >= MAX_SUBMITS_PER_HOUR || d >= MAX_SUBMITS_PER_DAY) {
    return 'Sistem sedang menerima terlalu banyak kiriman. Coba lagi beberapa saat lagi, atau hubungi pengurus masjid.';
  }
  cache.put(hourKey, String(h + 1), 3700);
  cache.put(dayKey, String(d + 1), 86500);
  return '';
}

// Simpan gambar bukti transfer ke Google Drive, dalam satu folder khusus
// (dibuat otomatis kalau belum ada), dan kembalikan URL yang bisa dibuka
// Bendahara langsung dari panel admin.
function saveProofToDrive(base64Data, mimeType, fileName, orderId) {
  const folder = getOrCreateProofFolder();
  const bytes = Utilities.base64Decode(base64Data);
  const safeBase = cleanText(fileName, 60).replace(/[\/\\]/g, '_') || 'bukti';
  const blob = Utilities.newBlob(bytes, mimeType, safeBase + '_' + orderId);
  const file = folder.createFile(blob);

  // Bukti transfer memuat data pribadi donatur — sengaja TIDAK dibuat
  // "siapa saja dengan link bisa lihat". File dibagikan hanya ke akun Google
  // Bendahara; orang lain yang membuka link diminta "Request Access".
  const bendaharaEmail = PropertiesService.getScriptProperties().getProperty('BENDAHARA_EMAIL');
  if (bendaharaEmail) {
    try {
      file.addViewer(bendaharaEmail);
    } catch (err) {
      // Email bukan akun Google / salah ketik: jangan gagalkan donasi. File tetap
      // aman (hanya pemilik project yang bisa buka). Periksa lewat cekKonfigurasi().
      console.warn('addViewer gagal untuk BENDAHARA_EMAIL: ' + err);
    }
  }
  return file;
}

function getOrCreateProofFolder() {
  const folders = DriveApp.getFoldersByName(PROOF_FOLDER_NAME);
  if (folders.hasNext()) {
    return folders.next();
  }
  // Lock: kalau folder belum pernah dibuat sama sekali (cuma terjadi di
  // awal pemakaian sistem) dan dua donatur upload bukti nyaris bersamaan,
  // tanpa lock keduanya bisa lolos pengecekan hasNext() di atas sebelum
  // salah satu sempat membuat foldernya — hasilnya dua folder duplikat
  // dengan nama sama. Lock memastikan hanya satu yang benar-benar membuat.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // Cek ulang di dalam lock — kemungkinan proses lain sudah membuatnya
    // sementara proses ini menunggu giliran.
    const foldersRecheck = DriveApp.getFoldersByName(PROOF_FOLDER_NAME);
    if (foldersRecheck.hasNext()) {
      return foldersRecheck.next();
    }
    return DriveApp.createFolder(PROOF_FOLDER_NAME);
  } finally {
    lock.releaseLock();
  }
}

// ========================================
// GOOGLE SHEETS — sheet Donasi (digital, menunggu/terverifikasi/ditolak)
// ========================================
function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.appendRow(DONASI_HEADERS);
    sheet.getRange('F:F').setNumberFormat('@'); // No HP: teks, supaya angka 0 di depan tidak hilang
  }
  return sheet;
}

function logDonation(orderId, category, amount, donorName, donorPhone, proofUrl, status, kodeUnik) {
  // Lock: dua donatur bisa mengirim bukti transfer hampir bersamaan.
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    // Kolom K (Nama Tampil) dikosongkan: kosong berarti memakai Nama Pengirim.
    sheet.appendRow([new Date(), orderId, category, amount, donorName, donorPhone, proofUrl, status, '', '', '', kodeUnik || '']);
    // appendRow memperlakukan "0812..." sebagai ANGKA (nol di depan hilang jadi 812...).
    // Tulis ulang kolom No HP sebagai teks supaya Bendahara bisa langsung menghubungi.
    sheet.getRange(sheet.getLastRow(), 6).setNumberFormat('@').setValue(String(donorPhone || ''));
  } finally {
    lock.releaseLock();
  }
}

// ========================================
// ADMIN — VALIDASI PIN
// ========================================
function validatePin(pin) {
  const adminPin = PropertiesService.getScriptProperties().getProperty('ADMIN_PIN');
  return !!adminPin && String(pin) === String(adminPin);
}

// Pemeriksa PIN dengan penguncian: setelah PIN_MAX_FAILS kali salah berturut-turut,
// SEMUA aksi admin ditolak selama PIN_LOCK_SECONDS (PIN yang benar pun ditolak —
// kalau tidak, penebak tetap bisa lanjut menebak). Mengembalikan null jika PIN benar,
// atau objek error siap kirim jika salah/terkunci.
function checkPin(pin) {
  if (_sessionOk) return null;   // token sesi sah: tidak perlu PIN (dan tidak ikut terkena penguncian PIN)
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get('pin_fails') || 0);
  if (fails >= PIN_MAX_FAILS) {
    return { success: false, message: 'Terlalu banyak percobaan PIN yang salah. Coba lagi sekitar ' + Math.round(PIN_LOCK_SECONDS / 60) + ' menit lagi.' };
  }
  if (validatePin(pin)) {
    if (fails) cache.remove('pin_fails');
    return null;
  }
  let lock = null;
  try { lock = LockService.getScriptLock(); lock.tryLock(3000); } catch (e) { lock = null; }
  try {
    const n = Number(cache.get('pin_fails') || 0) + 1;
    cache.put('pin_fails', String(n), PIN_LOCK_SECONDS);
    if (n === PIN_MAX_FAILS) {
      logAdmin('PIN_TERKUNCI', '-', 'Admin dikunci ' + Math.round(PIN_LOCK_SECONDS / 60) + ' menit setelah ' + n + ' PIN salah');
    }
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { /* abaikan */ } }
  }
  Utilities.sleep(700); // memperlambat tebakan beruntun
  return { success: false, message: 'PIN salah' };
}

// ========================================
// ADMIN — DAFTAR BUKTI TRANSFER MENUNGGU VERIFIKASI
// ========================================
function getPendingVerifications(pin) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;

  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const pending = [];

  for (let i = 1; i < data.length; i++) {
    if (normStatus(data[i][7]) === 'menunggu_verifikasi') {
      pending.push({
        // Sengaja TIDAK mengirim nomor baris (rowId) ke frontend. Baris di
        // Sheet bisa bergeser kalau Bendahara sort/hapus/edit manual lewat
        // Google Sheets UI — kalau itu terjadi, rowId lama bisa menunjuk ke
        // baris yang salah saat tombol Konfirmasi/Tolak ditekan nanti.
        // orderId aman dipakai sebagai identitas permanen karena dibuat unik
        // sekali saat donasi masuk dan tidak pernah berubah.
        waktu: data[i][0],
        orderId: data[i][1],
        kategori: DONATION_CATEGORY_LABELS[data[i][2]] || data[i][2],
        nominal: Number(data[i][3]),
        namaPengirim: data[i][4],
        noHp: data[i][5],
        linkBukti: data[i][6],
        namaTampil: data[i][10] || '',
        kodeUnik: data[i][11] || ''   // kosong = donatur tidak memakai kode unik (periksa lebih teliti)
      });
    }
  }

  // Tandai nominal kembar antar donasi pending (kode unik kadaluarsa/dilewati): Bendahara
  // tidak bisa membedakannya di mutasi, jadi perlu perhatian ekstra atau konfirmasi ke donatur.
  const count = {};
  pending.forEach(function (p) { count[p.nominal] = (count[p.nominal] || 0) + 1; });
  pending.forEach(function (p) { p.nominalKembar = count[p.nominal] > 1; });

  pending.sort(function (a, b) { return new Date(b.waktu) - new Date(a.waktu); });

  let totalPending = 0;
  pending.forEach(function (p) { totalPending += p.nominal; });

  return { success: true, pending: pending, totalPending: totalPending };
}

// ========================================
// ADMIN — KONFIRMASI / TOLAK BUKTI TRANSFER
// ========================================
function confirmDonation(pin, orderId) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  return updateDonationStatus(orderId, 'terverifikasi', '');
}

function rejectDonation(pin, orderId, reason) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  return updateDonationStatus(orderId, 'ditolak', cleanText(reason, 200));
}

// Dulu fungsi ini menerima nomor baris (rowId) langsung dari frontend dan
// percaya begitu saja bahwa baris itu masih donasi yang sama. Itu berbahaya:
// begitu Bendahara mulai memakai Sheet secara nyata (sort tanggal, hapus
// baris tes, dst lewat Google Sheets UI), nomor baris bisa bergeser, dan
// tombol Konfirmasi/Tolak bisa kena ke baris yang salah — misalnya
// mengonfirmasi donasi orang lain, atau menolak donasi yang belum pernah
// dicek. Sekarang fungsi ini mencari baris dengan mencocokkan orderId (kolom
// Order ID), yang dibuat unik sekali saat donasi masuk dan tidak pernah
// berubah — jadi identitasnya aman dari perubahan urutan/isi baris.
function updateDonationStatus(orderId, status, note) {
  if (!orderId) {
    return { success: false, message: 'Order ID tidak valid' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();

    let rowIndex = -1; // index di array `data`, BUKAN nomor baris sheet
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === orderId) {
        rowIndex = i;
        break;
      }
    }

    if (rowIndex === -1) {
      return { success: false, message: 'Data tidak ditemukan' };
    }

    const sheetRow = rowIndex + 1; // Sheets 1-indexed, header di baris 1
    if (normStatus(data[rowIndex][7]) !== 'menunggu_verifikasi') {
      return { success: false, message: 'Data ini sudah diproses sebelumnya' };
    }

    sheet.getRange(sheetRow, 8).setValue(status);
    sheet.getRange(sheetRow, 9).setValue(new Date());
    sheet.getRange(sheetRow, 10).setValue(note);
    logAdmin(status === 'terverifikasi' ? 'KONFIRMASI' : 'TOLAK', orderId, 'Rp ' + fmtRp(Number(data[rowIndex][3])) + (note ? ' | ' + note : ''));
    clearPublicCache();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

function normStatus(v) {
  return String(v === null || v === undefined ? '' : v).trim().toLowerCase();
}

// Salah pencet Konfirmasi/Tolak? Kembalikan ke "menunggu verifikasi" supaya bisa diputuskan ulang.
function reopenDonation(pin, orderId) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  if (!orderId) {
    return { success: false, message: 'Order ID tidak valid' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === orderId) {
        const cur = normStatus(data[i][7]);
        if (cur !== 'terverifikasi' && cur !== 'ditolak') {
          return { success: false, message: 'Hanya donasi yang sudah diputuskan yang bisa dibuka kembali' };
        }
        sheet.getRange(i + 1, 8).setValue('menunggu_verifikasi');
        sheet.getRange(i + 1, 9).setValue('');
        sheet.getRange(i + 1, 10).setValue('');
        logAdmin('BUKA_ULANG', orderId, 'Dari status ' + cur + ', Rp ' + fmtRp(Number(data[i][3])));
        clearPublicCache();
        return { success: true };
      }
    }
    return { success: false, message: 'Data tidak ditemukan' };
  } finally {
    lock.releaseLock();
  }
}

// ========================================
// ADMIN — SAMARKAN NAMA TAMPIL DONATUR (FR-17)
// ========================================
// Nama asli di kolom E tidak diubah (arsip Bendahara). Yang diganti hanya
// kolom K "Nama Tampil", yang dipakai oleh halaman publik.
function hideDonorName(pin, orderId) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  if (!orderId) {
    return { success: false, message: 'Order ID tidak valid' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][1] === orderId) {
        if (normStatus(data[i][7]) === 'ditolak') {
          return { success: false, message: 'Donasi yang ditolak tidak tampil di halaman publik' };
        }
        sheet.getRange(i + 1, 11).setValue(ANON_NAME);
        logAdmin('SAMARKAN_NAMA', orderId, '');
        clearPublicCache();
        return { success: true };
      }
    }
    return { success: false, message: 'Data tidak ditemukan' };
  } finally {
    lock.releaseLock();
  }
}

// ========================================
// ADMIN — BUKU KAS MANUAL (kotak amal, pengeluaran, dll)
// ========================================
function getCashBookSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(CASH_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CASH_SHEET_NAME);
    sheet.appendRow(KAS_HEADERS);
  }
  return sheet;
}

function newEntryId() {
  return 'KAS-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
}

// Pemasukan manual: wajib keterangan + nominal; kategori default "Kotak Amal".
// Pengeluaran: wajib kategori, penerima, keterangan, nominal; status default
// "Sudah Dibayar" (boleh "Direncanakan" — tidak mengurangi saldo sampai
// ditandai Sudah Dibayar).
// Kompatibel dengan admin.html lama: jika kategori/penerima/status sama sekali
// tidak dikirim (panggilan lama), dipakai nilai bawaan agar tidak error.
function addManualEntry(pin, tipe, keterangan, nominal, kategori, penerima, status, tanggal) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  if (tipe !== 'Pemasukan' && tipe !== 'Pengeluaran') {
    return { success: false, message: 'Tipe transaksi tidak valid' };
  }
  const amount = parseAmount(nominal);
  const desc = cleanText(keterangan, 120);
  if (!desc || !amount) {
    return { success: false, message: 'Data tidak lengkap' };
  }

  const legacyCall = (kategori === undefined && penerima === undefined && status === undefined);
  let cat = cleanText(kategori, 40);
  let recipient = cleanText(penerima, 60);
  let entryStatus;

  if (tipe === 'Pemasukan') {
    if (!cat) cat = 'Kotak Amal';
    if (INCOME_CATEGORIES.indexOf(cat) === -1) {
      return { success: false, message: 'Kategori pemasukan tidak valid' };
    }
    recipient = '';
    entryStatus = INCOME_VERIFIED;
  } else {
    if (legacyCall) {
      cat = 'Lainnya';
      recipient = '-';
    }
    if (!cat) {
      return { success: false, message: 'Kategori pengeluaran wajib diisi' };
    }
    if (EXPENSE_CATEGORIES.indexOf(cat) === -1) {
      return { success: false, message: 'Kategori pengeluaran tidak valid' };
    }
    if (!recipient) {
      return { success: false, message: 'Nama penerima wajib diisi' };
    }
    if (status && status !== EXPENSE_PAID && status !== EXPENSE_PLANNED) {
      return { success: false, message: 'Status pengeluaran tidak valid' };
    }
    entryStatus = status || EXPENSE_PAID;
  }

  // Tanggal transaksi (opsional, 'YYYY-MM-DD'). Bendahara memeriksa/mencatat kira-kira
  // sebulan sekali, jadi tanpa tanggal sendiri semua entri akan ber-tanggal "hari ini"
  // dan laporan mingguan/bulanan jadi salah periode.
  const dt = resolveEntryDate(tanggal);
  if (dt.error) {
    return { success: false, message: dt.error };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getCashBookSheet();
    const id = newEntryId();
    sheet.appendRow([dt.date, tipe, desc, amount, cat, recipient, entryStatus, id]);
    logAdmin('CATAT_' + tipe.toUpperCase(), id, cat + ' | Rp ' + fmtRp(amount) + ' | ' + desc);
    clearPublicCache();
  } finally {
    lock.releaseLock();
  }

  return { success: true };
}

// ----- Tanggal transaksi manual -----
// Disimpan jam 12:00 lokal (bukan tengah malam) supaya tanggalnya tidak "mundur satu
// hari" di perangkat/zona waktu lain saat dikirim sebagai ISO UTC ke halaman publik.
function parseLocalDateNoon(dateStr) {
  const parts = String(dateStr).split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 12, 0, 0, 0);
}

function ymdNum(d) {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

function findSaldoAwalDate() {
  const data = getCashBookSheet().getDataRange().getValues();
  let earliest = null;
  for (let i = 1; i < data.length; i++) {
    if (data[i][4] === SALDO_AWAL_CATEGORY && normStatus(data[i][6]) !== VOID_STATUS.toLowerCase()) {
      const d = new Date(data[i][0]);
      if (!isNaN(d.getTime()) && (!earliest || d < earliest)) earliest = d;
    }
  }
  return earliest;
}

// Kosong => sekarang. Ditolak: format salah, tanggal tidak ada (31 Feb), masa depan,
// atau SEBELUM Saldo Awal (transaksi itu sudah terhitung di Saldo Awal => dobel hitung).
function resolveEntryDate(tanggal) {
  if (tanggal === undefined || tanggal === null || tanggal === '') {
    return { date: new Date() };
  }
  const str = String(tanggal);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) {
    return { error: 'Format tanggal tidak valid' };
  }
  const d = parseLocalDateNoon(str);
  if (isNaN(d.getTime()) || d.getMonth() + 1 !== Number(str.substring(5, 7))) {
    return { error: 'Tanggal tidak valid' };
  }
  const today = new Date();
  if (ymdNum(d) > ymdNum(today)) {
    return { error: 'Tanggal tidak boleh di masa depan' };
  }
  const sa = findSaldoAwalDate();
  if (sa && ymdNum(d) < ymdNum(sa)) {
    return { error: 'Tanggal sebelum Saldo Awal sistem. Transaksi sebelum tanggal itu sudah termasuk dalam Saldo Awal.' };
  }
  return { date: (ymdNum(d) === ymdNum(today)) ? today : d };
}

// Pengeluaran "Direncanakan" -> "Sudah Dibayar". Waktu diperbarui ke saat
// ditandai dibayar, supaya laporan periode yang sudah pernah dibuat tidak
// berubah diam-diam (pengeluaran baru dihitung pada tanggal ia dibayar).
function markExpensePaid(pin, entryId, tanggal) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  if (!entryId) {
    return { success: false, message: 'ID entri tidak valid' };
  }
  // Tanggal bayar (opsional). Kosong => sekarang.
  const dt = resolveEntryDate(tanggal);
  if (dt.error) {
    return { success: false, message: dt.error };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getCashBookSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][7] === entryId) {
        if (data[i][1] !== 'Pengeluaran') {
          return { success: false, message: 'Entri ini bukan pengeluaran' };
        }
        if (normStatus(data[i][6]) === VOID_STATUS.toLowerCase()) {
          return { success: false, message: 'Entri ini sudah dibatalkan' };
        }
        if (normalizeExpenseStatus(data[i][6]) !== EXPENSE_PLANNED) {
          return { success: false, message: 'Pengeluaran ini sudah berstatus Sudah Dibayar' };
        }
        sheet.getRange(i + 1, 7).setValue(EXPENSE_PAID);
        sheet.getRange(i + 1, 1).setValue(dt.date);
        logAdmin('TANDAI_DIBAYAR', entryId, 'Rp ' + fmtRp(Number(data[i][3])));
        clearPublicCache();
        return { success: true };
      }
    }
    return { success: false, message: 'Data tidak ditemukan' };
  } finally {
    lock.releaseLock();
  }
}

// Saldo Awal sistem (FR-16): posisi kas pada saat sistem mulai dipakai.
// Disimpan di Buku Kas sebagai Tipe "Pemasukan" + Kategori "Saldo Awal",
// sehingga saldo tetap benar, tetapi TIDAK dihitung sebagai donasi/pemasukan
// (tidak masuk "Total Pemasukan" dan tidak tampil di daftar publik).
function addSaldoAwal(pin, tanggal, nominal) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  const amount = parseAmount(nominal);
  if (!amount) {
    return { success: false, message: 'Nominal tidak valid' };
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(tanggal || ''))) {
    return { success: false, message: 'Tanggal tidak valid' };
  }
  const when = parseLocalDateNoon(tanggal);
  if (isNaN(when.getTime()) || when.getMonth() + 1 !== Number(String(tanggal).substring(5, 7))) {
    return { success: false, message: 'Tanggal tidak valid' };
  }
  if (ymdNum(when) > ymdNum(new Date())) {
    return { success: false, message: 'Tanggal Saldo Awal tidak boleh di masa depan' };
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getCashBookSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][4] === SALDO_AWAL_CATEGORY && normStatus(data[i][6]) !== VOID_STATUS.toLowerCase()) {
        return { success: false, message: 'Saldo Awal sudah pernah dicatat. Jika salah, batalkan dulu entri Saldo Awal lama.' };
      }
    }
    const id = newEntryId();
    sheet.appendRow([when, 'Pemasukan', 'Saldo Awal Sistem', amount, SALDO_AWAL_CATEGORY, '', INCOME_VERIFIED, id]);
    logAdmin('SALDO_AWAL', id, 'Rp ' + fmtRp(amount) + ' per ' + tanggal);
    clearPublicCache();
    return { success: true };
  } finally {
    lock.releaseLock();
  }
}

// Batalkan entri Buku Kas yang salah input (nominal keliru, dobel, dll). Baris TIDAK
// dihapus: statusnya jadi "Dibatalkan", tidak dihitung ke saldo/laporan/halaman publik,
// dan alasannya tercatat di sheet "Log Admin".
function voidEntry(pin, entryId, reason) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  if (!entryId) {
    return { success: false, message: 'ID entri tidak valid' };
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sheet = getCashBookSheet();
    const data = sheet.getDataRange().getValues();
    for (let i = 1; i < data.length; i++) {
      if (data[i][7] === entryId) {
        if (normStatus(data[i][6]) === VOID_STATUS.toLowerCase()) {
          return { success: false, message: 'Entri ini sudah dibatalkan' };
        }
        sheet.getRange(i + 1, 7).setValue(VOID_STATUS);
        logAdmin('BATALKAN_ENTRI', entryId, data[i][1] + ' Rp ' + fmtRp(Number(data[i][3])) + ' | ' + cleanText(data[i][2], 60) + ' | alasan: ' + cleanText(reason, 100));
        clearPublicCache();
        return { success: true };
      }
    }
    return { success: false, message: 'Data tidak ditemukan' };
  } finally {
    lock.releaseLock();
  }
}

// ========================================
// BUKU BESAR TERPADU — satu sumber kebenaran untuk admin DAN publik
// ========================================
function normalizeExpenseStatus(value) {
  return String(value || '').trim().toLowerCase() === EXPENSE_PLANNED.toLowerCase() ? EXPENSE_PLANNED : EXPENSE_PAID;
}

// Membaca sheet Donasi + Buku Kas menjadi satu daftar catatan seragam.
// Donasi berstatus 'ditolak' (dan status tak dikenal) tidak ikut sama sekali.
// Baris Buku Kas dengan Tipe selain Pemasukan/Pengeluaran dilewati.
// Nominal harus berupa ANGKA di sel. Teks seperti "50.000" TIDAK boleh ditebak:
// Number("50.000") di JavaScript = 50 (titik dianggap desimal) => saldo kurang diam-diam.
function cellAmount(v) {
  return (typeof v === 'number' && isFinite(v) && v > 0) ? v : NaN;
}

function readLedgerRecords() {
  const records = [];
  _ledgerWarnings = [];
  const warn = function (msg) { if (_ledgerWarnings.length < 20) _ledgerWarnings.push(msg); };
  const isEmpty = function (row) {
    return row.every(function (c) { return c === '' || c === null || c === undefined; });
  };

  const donData = getSheet().getDataRange().getValues();
  for (let i = 1; i < donData.length; i++) {
    const r = donData[i];
    if (isEmpty(r)) continue;
    const st = normStatus(r[7]);
    let status;
    if (st === 'terverifikasi') status = INCOME_VERIFIED;
    else if (st === 'menunggu_verifikasi') status = INCOME_PENDING;
    else if (st === 'ditolak') continue;
    else { warn('Sheet Donasi baris ' + (i + 1) + ': status "' + r[7] + '" tidak dikenali, baris DILEWATI dari saldo'); continue; }

    // Satu sel rusak (mis. nominal diketik "50.000" sebagai teks, atau tanggal salah)
    // tidak boleh membuat seluruh saldo/halaman publik jadi NaN atau error.
    const nominal = cellAmount(r[3]);
    const waktu = new Date(r[0]);
    if (!isFinite(nominal) || nominal <= 0) { warn('Sheet Donasi baris ' + (i + 1) + ': nominal bukan angka valid (teks / kosong / nol), baris DILEWATI dari saldo'); continue; }
    if (isNaN(waktu.getTime())) { warn('Sheet Donasi baris ' + (i + 1) + ': tanggal tidak valid, baris DILEWATI dari saldo'); continue; }

    const catLabel = DONATION_CATEGORY_LABELS[r[2]] || String(r[2]);
    records.push({
      sumber: 'donasi',
      waktu: waktu,
      tipe: 'Pemasukan',
      kategori: catLabel,
      namaAsli: r[4] ? String(r[4]) : '',
      namaTampil: r[10] ? String(r[10]) : '',
      keterangan: '',
      penerima: '',
      nominal: nominal,
      status: status,
      orderId: r[1],
      entryId: '',
      saldoAwal: false
    });
  }

  const kasData = getCashBookSheet().getDataRange().getValues();
  for (let i = 1; i < kasData.length; i++) {
    const r = kasData[i];
    if (isEmpty(r)) continue;
    if (normStatus(r[6]) === VOID_STATUS.toLowerCase()) continue; // dibatalkan
    const tipeRaw = normStatus(r[1]);
    const tipe = tipeRaw === 'pemasukan' ? 'Pemasukan' : (tipeRaw === 'pengeluaran' ? 'Pengeluaran' : null);
    if (!tipe) { warn('Buku Kas baris ' + (i + 1) + ': Tipe "' + r[1] + '" tidak dikenali, baris DILEWATI dari saldo'); continue; }

    const nominal = cellAmount(r[3]);
    const waktu = new Date(r[0]);
    if (!isFinite(nominal) || nominal <= 0) { warn('Buku Kas baris ' + (i + 1) + ': nominal bukan angka valid (teks / kosong / nol), baris DILEWATI dari saldo'); continue; }
    if (isNaN(waktu.getTime())) { warn('Buku Kas baris ' + (i + 1) + ': tanggal tidak valid, baris DILEWATI dari saldo'); continue; }
    const rawSt = normStatus(r[6]);
    if (tipe === 'Pengeluaran' && rawSt && rawSt !== 'sudah dibayar' && rawSt !== 'direncanakan') {
      warn('Buku Kas baris ' + (i + 1) + ': status "' + r[6] + '" tidak dikenali, dihitung Sudah Dibayar');
    }

    const isSaldoAwal = (tipe === 'Pemasukan' && r[4] === SALDO_AWAL_CATEGORY);
    records.push({
      sumber: 'kas',
      waktu: waktu,
      tipe: tipe,
      kategori: String(r[4] || '').trim() || (tipe === 'Pemasukan' ? 'Kotak Amal' : 'Lainnya'),
      namaAsli: '',
      namaTampil: '',
      keterangan: String(r[2] || ''),
      penerima: String(r[5] || ''),
      nominal: nominal,
      status: tipe === 'Pemasukan' ? INCOME_VERIFIED : normalizeExpenseStatus(r[6]),
      orderId: '',
      entryId: r[7] ? String(r[7]) : '',
      saldoAwal: isSaldoAwal
    });
  }

  return records;
}

// Rumus tunggal:  Saldo = Saldo Awal + Total Pemasukan - Total Pengeluaran
// - Donasi "Menunggu Verifikasi" dan pengeluaran "Direncanakan" TIDAK dihitung.
function computeLedger() {
  const records = readLedgerRecords();
  const out = {
    records: records,
    saldoAwal: 0, saldoAwalTanggal: null,
    totalPemasukan: 0, totalPengeluaran: 0,
    pendingCount: 0, pendingTotal: 0,
    plannedCount: 0, plannedTotal: 0,
    warnings: _ledgerWarnings.slice()
  };

  records.forEach(function (r) {
    if (r.saldoAwal) {
      out.saldoAwal += r.nominal;
      if (!out.saldoAwalTanggal || r.waktu < out.saldoAwalTanggal) out.saldoAwalTanggal = r.waktu;
    } else if (r.tipe === 'Pemasukan') {
      if (r.status === INCOME_PENDING) { out.pendingCount++; out.pendingTotal += r.nominal; }
      else out.totalPemasukan += r.nominal;
    } else {
      if (r.status === EXPENSE_PLANNED) { out.plannedCount++; out.plannedTotal += r.nominal; }
      else out.totalPengeluaran += r.nominal;
    }
  });

  out.saldo = out.saldoAwal + out.totalPemasukan - out.totalPengeluaran;
  return out;
}

// ========================================
// ADMIN — GABUNGKAN DONASI TERVERIFIKASI + ENTRI MANUAL
// ========================================
function getLedgerData(pin) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;

  const c = computeLedger();
  const entries = [];

  // Donasi 'menunggu_verifikasi' dan 'ditolak' sengaja TIDAK masuk daftar ini
  // (bukan uang resmi masjid sampai dicocokkan ke mutasi asli); yang menunggu
  // punya layar verifikasi sendiri. Pengeluaran "Direncanakan" tampil di daftar
  // (diberi tanda) tetapi tidak mengurangi saldo.
  c.records.forEach(function (r) {
    if (r.sumber === 'donasi' && r.status === INCOME_PENDING) return;
    const donorLabel = r.namaAsli ? (' \u2014 ' + r.namaAsli) : '';
    entries.push({
      waktu: r.waktu,
      tipe: r.tipe,
      keterangan: r.sumber === 'donasi' ? (r.kategori + ' (Transfer)' + donorLabel) : r.keterangan,
      nominal: r.nominal,
      kategori: r.kategori,
      penerima: r.penerima,
      status: r.status,
      sumber: r.sumber,
      orderId: r.orderId,
      entryId: r.entryId,
      namaTampil: r.namaTampil
    });
  });

  entries.sort(function (a, b) { return new Date(b.waktu) - new Date(a.waktu); });

  return {
    success: true,
    entries: entries,
    totalBalance: c.saldo,
    hasSaldoAwal: c.saldoAwalTanggal !== null,
    plannedCount: c.plannedCount,
    plannedTotal: c.plannedTotal,
    saldoAwalTanggal: c.saldoAwalTanggal,
    rekonsiliasiRiwayat: readRekonsiliasi(12),
    warnings: c.warnings   // data janggal di Sheet yang dilewati dari saldo (tampilkan ke Bendahara!)
  };
}

// ========================================
// ADMIN — LAPORAN PERIODE (format saldo awal/penerimaan/pengeluaran/saldo akhir)
// ========================================
function generateReport(pin, startDate, endDate) {
  const allData = getLedgerData(pin);
  if (!allData.success) return allData;

  // PENTING: jangan pakai `new Date('2026-09-14')` langsung — string tanggal
  // tanpa jam selalu di-parse JavaScript sebagai tengah malam UTC, bukan
  // tengah malam lokal. Untuk Jayapura (UTC+9), itu bikin batas "dari tanggal"
  // meleset 9 jam ke depan, jadi transaksi pagi hari bisa salah masuk ke
  // Saldo Awal alih-alih ke Penerimaan/Pengeluaran hari itu. Parse manual
  // per-komponen supaya selalu jadi tengah malam di timezone lokal server.
  const start = parseLocalDateStart(startDate);
  const end = parseLocalDateEnd(endDate);

  let saldoAwal = 0;
  const penerimaan = [];
  const pengeluaran = [];

  allData.entries.forEach(function (entry) {
    if (entry.status === EXPENSE_PLANNED) return; // rencana belum dibayar: bukan transaksi
    const t = new Date(entry.waktu);
    const signedAmount = entry.tipe === 'Pemasukan' ? entry.nominal : -entry.nominal;

    // Saldo Awal sistem selalu dibaca sebagai saldo awal laporan (bukan
    // "penerimaan"), selama tanggalnya belum melewati akhir periode.
    if (entry.kategori === SALDO_AWAL_CATEGORY && entry.tipe === 'Pemasukan') {
      if (t <= end) saldoAwal += signedAmount;
      return;
    }

    if (t < start) {
      saldoAwal += signedAmount;
    } else if (t >= start && t <= end) {
      if (entry.tipe === 'Pemasukan') {
        penerimaan.push(entry);
      } else {
        pengeluaran.push(entry);
      }
    }
  });

  const totalPenerimaan = penerimaan.reduce(function (sum, e) { return sum + e.nominal; }, 0);
  const totalPengeluaran = pengeluaran.reduce(function (sum, e) { return sum + e.nominal; }, 0);

  return {
    success: true,
    saldoAwal: saldoAwal,
    penerimaan: penerimaan,
    totalPenerimaan: totalPenerimaan,
    pengeluaran: pengeluaran,
    totalPengeluaran: totalPengeluaran,
    saldoAkhir: saldoAwal + totalPenerimaan - totalPengeluaran
  };
}

// Parse 'YYYY-MM-DD' (dari <input type="date">) jadi 00:00:00 di timezone
// lokal, bukan UTC. new Date('YYYY-MM-DD') di JS selalu UTC midnight —
// ini yang bikin batas laporan meleset kalau timezone project bukan UTC.
function parseLocalDateStart(dateStr) {
  const parts = dateStr.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 0, 0, 0, 0);
}

function parseLocalDateEnd(dateStr) {
  const parts = dateStr.split('-').map(Number);
  return new Date(parts[0], parts[1] - 1, parts[2], 23, 59, 59, 999);
}

// ========================================
// PUBLIK — DATA BERANDA (tanpa PIN, HANYA-BACA, hanya kolom yang diizinkan)
// ========================================
// Data publik dibangun dengan memilih kolom satu per satu (daftar putih).
// Tidak pernah mengirim: No HP, Link Bukti, Order ID, catatan penolakan,
// waktu verifikasi, maupun donasi yang ditolak.
function buildPublicData() {
  const c = computeLedger();
  const incomes = [];
  const expenses = [];
  const incomeCat = {};
  const expenseCat = {};

  c.records.forEach(function (r) {
    if (r.saldoAwal) return; // Saldo Awal tampil sebagai keterangan tersendiri, bukan transaksi

    if (r.tipe === 'Pemasukan') {
      incomes.push({
        _t: r.waktu.getTime(),
        tanggal: r.waktu.toISOString(),
        // Nama baru tampil setelah diverifikasi: selama "Menunggu Verifikasi" (bisa ~1 bulan)
        // nama yang diketik orang tak dikenal belum diperiksa siapa pun.
        nama: r.sumber === 'donasi' ? (r.status === INCOME_PENDING ? ANON_NAME : sanitizeDonorName(r.namaTampil || r.namaAsli)) : cleanText(r.keterangan, 120),
        kategori: cleanText(r.kategori, 40),
        nominal: r.nominal,
        status: r.status
      });
      if (r.status === INCOME_VERIFIED) incomeCat[r.kategori] = (incomeCat[r.kategori] || 0) + r.nominal;
    } else {
      expenses.push({
        _t: r.waktu.getTime(),
        tanggal: r.waktu.toISOString(),
        keterangan: cleanText(r.keterangan, 120),
        kategori: cleanText(r.kategori, 40),
        penerima: cleanText(r.penerima, 60),
        nominal: r.nominal,
        status: r.status
      });
      if (r.status === EXPENSE_PAID) expenseCat[r.kategori] = (expenseCat[r.kategori] || 0) + r.nominal;
    }
  });

  const rekon = readRekonsiliasi(1)[0] || null;
  if (rekon) delete rekon.id;

  const newestFirst = function (a, b) { return b._t - a._t; };
  const strip = function (item) { delete item._t; return item; };
  incomes.sort(newestFirst);
  expenses.sort(newestFirst);
  incomes.forEach(strip);
  expenses.forEach(strip);

  const toList = function (map) {
    return Object.keys(map)
      .map(function (k) { return { kategori: k, total: map[k] }; })
      .sort(function (a, b) { return b.total - a.total; });
  };

  return {
    updatedAt: new Date().toISOString(),
    summary: {
      saldo: c.saldo,
      saldoAwal: c.saldoAwal,
      saldoAwalTanggal: c.saldoAwalTanggal ? c.saldoAwalTanggal.toISOString() : null,
      totalPemasukan: c.totalPemasukan,
      totalPengeluaran: c.totalPengeluaran,
      pendingCount: c.pendingCount,
      pendingTotal: c.pendingTotal
    },
    incomeByCategory: toList(incomeCat),
    expenseByCategory: toList(expenseCat),
    rekonsiliasi: rekon,
    incomes: incomes,
    expenses: expenses
  };
}

function getPublicOverview() {
  const d = getPublicData();
  return {
    success: true,
    updatedAt: d.updatedAt,
    summary: d.summary,
    incomeByCategory: d.incomeByCategory,
    expenseByCategory: d.expenseByCategory,
    rekonsiliasi: d.rekonsiliasi || null
  };
}

function getPublicHistory(type, offset) {
  const d = getPublicData();
  const list = type === 'income' ? d.incomes : (type === 'expense' ? d.expenses : null);
  if (!list) {
    return { success: false, message: 'Jenis riwayat tidak dikenali' };
  }
  const start = Math.max(0, parseInt(offset, 10) || 0);
  const items = list.slice(start, start + PUBLIC_PAGE_SIZE);
  return {
    success: true,
    type: type,
    items: items,
    nextOffset: start + items.length,
    total: list.length,
    hasMore: start + items.length < list.length,
    updatedAt: d.updatedAt
  };
}

// ----- Penyimpanan sementara (cache) maksimal 5 menit -----
// CacheService membatasi 100 KB per nilai, sedangkan riwayat bisa bertambah
// banyak. Jadi data dikompres (gzip), diubah ke teks, lalu dipotong per 90 KB.
function getPublicData() {
  const cache = CacheService.getScriptCache();
  try {
    const cached = readPublicCache(cache);
    if (cached) return cached;
  } catch (err) { /* cache rusak: bangun ulang di bawah */ }

  const data = buildPublicData();
  try { writePublicCache(cache, data); } catch (err) { /* cache gagal: tetap kembalikan data */ }
  return data;
}

function writePublicCache(cache, data) {
  const gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(data), 'application/json', 'pub.json'));
  const b64 = Utilities.base64Encode(gz.getBytes());
  const size = 90000;
  const entries = {};
  let n = 0;
  for (let i = 0; i < b64.length; i += size) {
    entries[PUBLIC_CACHE_PREFIX + n] = b64.substring(i, i + size);
    n++;
  }
  entries[PUBLIC_CACHE_PREFIX + 'n'] = String(n);
  cache.putAll(entries, PUBLIC_CACHE_SECONDS);
}

function readPublicCache(cache) {
  const n = Number(cache.get(PUBLIC_CACHE_PREFIX + 'n'));
  if (!n) return null;
  const keys = [];
  for (let i = 0; i < n; i++) keys.push(PUBLIC_CACHE_PREFIX + i);
  const got = cache.getAll(keys);
  let b64 = '';
  for (let i = 0; i < n; i++) {
    const part = got[PUBLIC_CACHE_PREFIX + i];
    if (!part) return null;
    b64 += part;
  }
  const json = Utilities.ungzip(Utilities.newBlob(Utilities.base64Decode(b64), 'application/x-gzip')).getDataAsString();
  return JSON.parse(json);
}

// Dipanggil setiap ada perubahan data (donasi masuk, konfirmasi/tolak, catat
// transaksi, dst) supaya tampilan publik langsung ikut diperbarui.
function clearPublicCache() {
  try { CacheService.getScriptCache().remove(PUBLIC_CACHE_PREFIX + 'n'); } catch (err) { /* abaikan */ }
}

// ========================================
// SETUP SEKALI JALAN — jalankan MANUAL satu kali setelah memperbarui kode
// ========================================
// Cara: pilih fungsi "setupBerandaPublik" di dropdown editor Apps Script,
// klik Run. Fungsi ini hanya MENAMBAH judul kolom baru dan menandai baris
// "Saldo Awal" lama (jika ada). Tidak ada data yang dihapus atau diubah nilainya.
function setupBerandaPublik() {
  const log = [];

  const addHeader = function (sheet, col, title) {
    const cell = sheet.getRange(1, col);
    if (!String(cell.getValue() || '').trim()) {
      cell.setValue(title);
      log.push('Judul kolom ditambahkan: ' + sheet.getName() + ' kolom ' + col + ' = ' + title);
    }
  };

  const donasi = getSheet();
  addHeader(donasi, 11, 'Nama Tampil');
  addHeader(donasi, 12, 'Kode Unik');
  getRekonSheet();
  donasi.getRange('F:F').setNumberFormat('@');
  log.push('Kolom No HP (Donasi) diset sebagai teks');

  const kas = getCashBookSheet();
  addHeader(kas, 5, 'Kategori');
  addHeader(kas, 6, 'Penerima');
  addHeader(kas, 7, 'Status');
  addHeader(kas, 8, 'ID Entri');

  // Baris Saldo Awal yang dulu dicatat manual sebagai pemasukan biasa
  // (mis. "Saldo Awal Migrasi") ditandai supaya tidak dihitung sebagai donasi.
  const data = kas.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const kategoriKosong = !String(data[i][4] || '').trim();
    if (data[i][1] === 'Pemasukan' && kategoriKosong && /^\s*saldo awal/i.test(String(data[i][2]))) {
      kas.getRange(i + 1, 5).setValue(SALDO_AWAL_CATEGORY);
      kas.getRange(i + 1, 7).setValue(INCOME_VERIFIED);
      log.push('Baris ' + (i + 1) + ' Buku Kas ("' + data[i][2] + '") ditandai sebagai Saldo Awal');
    }
  }

  clearPublicCache();
  if (log.length === 0) log.push('Tidak ada yang perlu diubah (sudah siap).');
  Logger.log(log.join('\n'));
  return log;
}


// ========================================
// LOG AKTIVITAS ADMIN (sheet "Log Admin") — jejak audit, tidak pernah tampil publik
// ========================================
function logAdmin(action, target, detail) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let sh = ss.getSheetByName(LOG_SHEET_NAME);
    if (!sh) {
      sh = ss.insertSheet(LOG_SHEET_NAME);
      sh.appendRow(['Waktu', 'Aksi', 'Target', 'Detail']);
    }
    sh.appendRow([new Date(), action, cleanText(target, 80), cleanText(detail, 250)]);
  } catch (err) {
    console.error('logAdmin gagal: ' + err); // log tidak boleh menggagalkan aksi utama
  }
}

// ========================================
// CEK KONFIGURASI — jalankan MANUAL setelah setup/deploy (dropdown fungsi > Run)
// ========================================
function cekKonfigurasi() {
  const out = [];
  const props = PropertiesService.getScriptProperties();
  const pin = props.getProperty('ADMIN_PIN');
  const email = props.getProperty('BENDAHARA_EMAIL');

  if (!pin) out.push('GAGAL : ADMIN_PIN belum diisi di Script Properties');
  else if (pin.length < 8) out.push('BAHAYA: ADMIN_PIN cuma ' + pin.length + ' karakter. Pakai minimal 8 (campur huruf & angka).');
  else out.push('OK    : ADMIN_PIN terisi (' + pin.length + ' karakter)');

  if (!email) out.push('GAGAL : BENDAHARA_EMAIL belum diisi (bukti transfer tidak terbagi ke Bendahara)');
  else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) out.push('GAGAL : BENDAHARA_EMAIL bukan alamat email yang valid');
  else out.push('OK    : BENDAHARA_EMAIL = ' + email);

  const tz = Session.getScriptTimeZone();
  out.push(tz === 'Asia/Jayapura' ? 'OK    : zona waktu Asia/Jayapura'
    : 'BAHAYA: zona waktu skrip "' + tz + '" — ganti ke Asia/Jayapura (Project Settings), kalau tidak batas tanggal laporan meleset');

  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (!ss) throw new Error('null');
    out.push('OK    : terhubung ke Spreadsheet "' + ss.getName() + '"');
    const check = function (sheet, headers) {
      const got = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
      headers.forEach(function (h, i) {
        if (String(got[i] || '').trim() !== h) out.push('PERIKSA: sheet "' + sheet.getName() + '" kolom ' + (i + 1) + ' seharusnya "' + h + '", isinya "' + got[i] + '" (jalankan setupBerandaPublik)');
      });
    };
    check(getSheet(), DONASI_HEADERS);
    check(getCashBookSheet(), KAS_HEADERS);
    check(getRekonSheet(), REKON_HEADERS);
  } catch (err) {
    out.push('GAGAL : tidak terhubung ke Spreadsheet. Script harus dibuat dari Sheet: Extensions > Apps Script. (' + err + ')');
  }

  const hasBackup = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'backupMingguan'; });
  out.push(hasBackup ? 'OK    : backup mingguan aktif' : 'INFO  : backup otomatis belum dipasang (jalankan pasangBackupOtomatis)');

  Logger.log(out.join('\n'));
  return out;
}

// ========================================
// BACKUP OTOMATIS — salinan Spreadsheet tiap Minggu dini hari, simpan 8 terakhir
// ========================================
function pasangBackupOtomatis() {
  const exists = ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'backupMingguan'; });
  if (exists) { Logger.log('Backup mingguan sudah terpasang.'); return; }
  ScriptApp.newTrigger('backupMingguan').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(2).create();
  backupMingguan(); // satu backup langsung sekarang
  Logger.log('Backup mingguan dipasang (Minggu ~02.00) dan satu salinan sudah dibuat.');
}

function backupMingguan() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER_NAME);
  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER_NAME);
  const stamp = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  DriveApp.getFileById(ss.getId()).makeCopy('Backup ' + ss.getName() + ' ' + stamp, folder);

  const files = [];
  const it = folder.getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.getName().indexOf('Backup ') === 0) files.push(f);
  }
  files.sort(function (a, b) { return b.getDateCreated() - a.getDateCreated(); });
  files.slice(BACKUP_KEEP).forEach(function (f) { f.setTrashed(true); });
}


// ========================================
// REKONSILIASI: SALDO REKENING BANK vs SALDO BUKU
// ========================================
// Saldo publik adalah saldo BUKU (hasil catatan), bukan saldo rekening. Transfer yang
// donaturnya lupa upload bukti, atau uang tunai kotak amal yang belum disetor, membuat
// keduanya berbeda. Bendahara mencatat saldo rekening BSI (+ kas tunai di tangan) per
// tanggal tertentu; sistem menyimpan potret saldo buku di tanggal itu dan menghitung selisih.
//   selisih             = (rekening + tunai) - buku
//   selisihBelumTerjelaskan = (rekening + tunai) - (buku + donasi menunggu verifikasi)
// Nol pada angka kedua = semua uang riil sudah terjelaskan oleh catatan.
function getRekonSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(REKON_SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(REKON_SHEET_NAME);
    sheet.appendRow(REKON_HEADERS);
  }
  return sheet;
}

function strictRupiah(v) { // angka bulat >= 0, selain itu NaN (teks "50.000" TIDAK ditebak)
  if (typeof v === 'number') return (isFinite(v) && v >= 0 && v <= 1000000000000) ? Math.round(v) : NaN;
  if (typeof v === 'string' && /^\d{1,13}$/.test(v.trim())) return Number(v.trim());
  return NaN;
}

// Saldo buku & donasi menunggu per akhir hari `endDate` (aturan sama dengan computeLedger).
function balanceAsOf(records, endDate) {
  const end = endDate.getTime();
  let buku = 0, pending = 0;
  records.forEach(function (r) {
    if (r.waktu.getTime() > end) return;
    if (r.saldoAwal) buku += r.nominal;
    else if (r.tipe === 'Pemasukan') {
      if (r.status === INCOME_PENDING) pending += r.nominal; else buku += r.nominal;
    } else if (r.status !== EXPENSE_PLANNED) {
      buku -= r.nominal;
    }
  });
  return { buku: buku, pending: pending };
}

function catatSaldoBank(pin, tanggal, saldoBank, kasTunai, catatan) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;

  const bank = strictRupiah(saldoBank);
  const tunai = (kasTunai === undefined || kasTunai === null || kasTunai === '') ? 0 : strictRupiah(kasTunai);
  if (isNaN(bank) || isNaN(tunai)) {
    return { success: false, message: 'Saldo rekening / kas tunai harus berupa angka bulat tanpa titik (0 atau lebih)' };
  }
  const dt = resolveEntryDate(tanggal);
  if (dt.error) {
    return { success: false, message: dt.error };
  }
  const d = dt.date;
  const endOfDay = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const b = balanceAsOf(computeLedger().records, endOfDay);
    const id = 'RKN-' + new Date().getTime() + '-' + Math.floor(Math.random() * 1000);
    getRekonSheet().appendRow([new Date(), d, bank, tunai, b.buku, b.pending, (bank + tunai) - b.buku, cleanText(catatan, 150), id]);
    logAdmin('REKONSILIASI', id, 'Rekening Rp ' + fmtRp(bank) + ' + tunai Rp ' + fmtRp(tunai) + ' vs buku Rp ' + fmtRp(b.buku));
    clearPublicCache();
    return {
      success: true,
      saldoBuku: b.buku,
      pendingTotal: b.pending,
      selisih: (bank + tunai) - b.buku,
      selisihBelumTerjelaskan: (bank + tunai) - (b.buku + b.pending)
    };
  } finally {
    lock.releaseLock();
  }
}

// Terbaru dulu (tanggal saldo, lalu waktu input). Baris rusak dilewati.
function readRekonsiliasi(limit) {
  const data = getRekonSheet().getDataRange().getValues();
  const num = function (v) { return (typeof v === 'number' && isFinite(v)) ? v : NaN; };
  const out = [];
  for (let i = 1; i < data.length; i++) {
    const r = data[i];
    const tgl = new Date(r[1]);
    const input = new Date(r[0]);
    const bank = num(r[2]), tunai = num(r[3]), buku = num(r[4]), pending = num(r[5]);
    if (isNaN(tgl.getTime()) || isNaN(input.getTime()) || isNaN(bank) || isNaN(tunai) || isNaN(buku) || isNaN(pending)) continue;
    const unexplained = (bank + tunai) - (buku + pending);
    out.push({
      tanggal: tgl.toISOString(),
      dicatatPada: input.toISOString(),
      saldoBank: bank,
      kasTunai: tunai,
      saldoBuku: buku,
      pendingTotal: pending,
      selisih: (bank + tunai) - buku,
      selisihBelumTerjelaskan: unexplained,
      sesuai: unexplained === 0,
      catatan: cleanText(r[7], 150),
      id: r[8] ? String(r[8]) : '',
      _t: tgl.getTime(),
      _i: input.getTime()
    });
  }
  out.sort(function (a, b) { return (b._t - a._t) || (b._i - a._i); });
  return out.slice(0, limit || 12).map(function (x) { delete x._t; delete x._i; return x; });
}


// ========================================
// SESI ADMIN
// ========================================
// login(PIN) -> token acak 256-bit disimpan di CacheService selama SESSION_IDLE_SECONDS dan
// diperpanjang tiap request sah (sliding), maksimum SESSION_MAX_SECONDS sejak masuk.
// Percobaan login memakai pemeriksa PIN yang sama, jadi tetap kena penguncian PIN salah.
// Token tidak bisa dipakai menebak PIN, dan Keluar mencabutnya di server.
function loginAdmin(pin) {
  const pinError = checkPin(pin);
  if (pinError) return pinError;
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '').toLowerCase();
  CacheService.getScriptCache().put('sess_' + token, String(Date.now()), SESSION_IDLE_SECONDS);
  logAdmin('LOGIN', '-', 'Sesi admin dimulai');
  return { success: true, token: token, idleSeconds: SESSION_IDLE_SECONDS };
}

function checkSession(token) {
  if (!/^[0-9a-f]{64}$/.test(String(token))) return false;
  const cache = CacheService.getScriptCache();
  const created = cache.get('sess_' + token);
  if (!created) return false;
  if (Date.now() - Number(created) > SESSION_MAX_SECONDS * 1000) {
    cache.remove('sess_' + token);
    return false;
  }
  cache.put('sess_' + token, created, SESSION_IDLE_SECONDS);   // perpanjang: 15 menit lagi
  return true;
}

function logoutAdmin(token) {
  if (/^[0-9a-f]{64}$/.test(String(token))) {
    CacheService.getScriptCache().remove('sess_' + token);
    logAdmin('LOGOUT', '-', 'Sesi admin diakhiri');
  }
  return { success: true };
}
