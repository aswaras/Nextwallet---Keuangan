/* ==========================================================================
   NEXWALLET APP LOGIC
   - Semua perubahan disimpan instan ke localStorage (optimistic UI)
   - Sinkronisasi ke backend (Google Apps Script) berjalan di BACKGROUND
     tanpa pernah memblokir layar. Hanya indikator kecil di pojok kanan atas.
   ========================================================================== */

// ================== UTILS ==================
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0, v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    }));

const formatRupiah = (n) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(n) || 0);

async function sha256(text) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function todayStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function nowTimeStr() {
    const d = new Date();
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

const CATEGORY_ICONS = {
    'Makan': 'utensils', 'Transportasi': 'car', 'Belanja': 'shopping-bag', 'Tagihan': 'receipt',
    'Listrik': 'zap', 'Gaji': 'briefcase', 'Penjualan': 'shopping-bag', 'Bonus': 'gift',
    'Investasi': 'trending-up', 'Lainnya': 'more-horizontal', 'Pembayaran Piutang': 'arrow-down-to-line',
    'Bayar Hutang': 'arrow-up-from-line'
};
const CATEGORIES = {
    income: ['Gaji', 'Penjualan', 'Bonus', 'Investasi', 'Lainnya'],
    expense: ['Makan', 'Transportasi', 'Belanja', 'Tagihan', 'Listrik', 'Lainnya']
};
const WALLET_ICON_MAP = { 'Bank': 'building-2', 'Cash': 'banknote', 'E-Wallet': 'smartphone', 'Investasi': 'trending-up', 'Lainnya': 'wallet' };
const WALLET_COLOR_MAP = { 'Bank': 'bg-blue-500', 'Cash': 'bg-emerald-500', 'E-Wallet': 'bg-sky-400', 'Investasi': 'bg-purple-500', 'Lainnya': 'bg-gray-500' };

// ================== STORE (local persistence + in-memory state) ==================
const Store = {
    state: { wallets: [], transactions: [], debts: [], settings: {} },
    KEY: 'nexwallet_data_v1',

    loadLocal() {
        try {
            const raw = localStorage.getItem(this.KEY);
            if (raw) {
                this.state = JSON.parse(raw);
            } else {
                this.state = {
                    wallets: [{ id: uuid(), name: 'Cash', type: 'Cash', balance: 0, color: 'bg-emerald-500', icon: 'banknote' }],
                    transactions: [],
                    debts: [],
                    settings: { userName: 'Pengguna Baru', pinHash: '', themeColor: 'blue', darkMode: 'false' }
                };
                this.saveLocal();
            }
        } catch (e) {
            console.error('loadLocal error', e);
        }
    },
    saveLocal() {
        localStorage.setItem(this.KEY, JSON.stringify(this.state));
    },
    replaceAll(data) {
        const oldPinHash = this.state.settings.pinHash;

        this.state.wallets = data.wallets || this.state.wallets;
        this.state.transactions = data.transactions || this.state.transactions;
        this.state.debts = data.debts || this.state.debts;
        this.state.settings = Object.assign({}, this.state.settings, data.settings || {});

        // GUARD PENTING: jangan pernah biarkan PIN yang sudah diset lokal
        // hilang/kosong gara-gara data settings dari server masih kosong/belum ke-update.
        // Kalau ini terjadi, kirim ulang PIN lokal ke server supaya server ikut benar.
        if (!this.state.settings.pinHash && oldPinHash) {
            this.state.settings.pinHash = oldPinHash;
            if (typeof Sync !== 'undefined') Sync.enqueue('updateSettings', { pinHash: oldPinHash });
        }

        this.saveLocal();
    }
};

// ================== BACKGROUND SYNC ENGINE ==================
const Sync = {
    QUEUE_KEY: 'nexwallet_queue_v1',
    URL_KEY: 'nexwallet_api_url',
    queue: [],
    flushing: false,
    retryTimer: null,

    getApiUrl() {
        // Prioritas: override manual di localStorage (jika pernah diset) > konfigurasi di index.html
        const stored = localStorage.getItem(this.URL_KEY);
        if (stored) return stored;
        const fromConfig = (window.NEXWALLET_CONFIG && window.NEXWALLET_CONFIG.API_URL) || '';
        if (!fromConfig || fromConfig.indexOf('PASTE_URL_DEPLOY_APPS_SCRIPT_DISINI') !== -1) return '';
        return fromConfig.trim();
    },
    setApiUrl(url) { localStorage.setItem(this.URL_KEY, url.trim()); },

    loadQueue() {
        try { this.queue = JSON.parse(localStorage.getItem(this.QUEUE_KEY)) || []; } catch (e) { this.queue = []; }
    },
    saveQueue() { localStorage.setItem(this.QUEUE_KEY, JSON.stringify(this.queue)); },

    enqueue(action, payload) {
        this.queue.push({ id: uuid(), action, payload, ts: Date.now() });
        this.saveQueue();
        this.scheduleFlush();
    },

    scheduleFlush() {
        clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this.flushQueue(), 400);
    },

    lastStatus: 'idle',

    setIndicator(mode) {
        this.lastStatus = mode;
        const el = document.getElementById('sync-indicator');
        if (el) {
            el.classList.remove('spin', 'ok', 'err', 'off');
            let iconName = 'loader-2';
            if (mode === 'syncing') {
                el.classList.add('show', 'spin');
                iconName = 'loader-2';
            } else if (mode === 'ok') {
                el.classList.add('show', 'ok');
                iconName = 'check';
                setTimeout(() => el.classList.remove('show'), 1500);
            } else if (mode === 'err') {
                el.classList.add('show', 'err');
                iconName = 'cloud-off';
                setTimeout(() => el.classList.remove('show'), 2500);
            } else if (mode === 'off') {
                el.classList.add('show', 'off');
                iconName = 'cloud-off';
                setTimeout(() => el.classList.remove('show'), 1500);
            } else {
                el.classList.remove('show');
            }
            // Reset ke tag <i> murni tiap kali, karena lucide.createIcons() mengubah <i> jadi <svg>
            // (kalau tidak di-reset, querySelector('i') akan null di panggilan berikutnya dan crash)
            el.innerHTML = `<i data-lucide="${iconName}" class="w-3.5 h-3.5"></i>`;
            if (window.lucide) lucide.createIcons();
        }
        // Live-update status text kalau halaman Settings sedang terbuka
        const page = document.getElementById('page-settings');
        if (page && !page.classList.contains('hidden')) Settings.renderPage();
    },

    async testConnection() {
        const box = document.getElementById('api-debug-box');
        const debugText = document.getElementById('api-debug-text');
        box.classList.remove('hidden');
        debugText.innerText = 'Menghubungi server...';

        const url = this.getApiUrl();
        if (!url) {
            debugText.innerText = '❌ API_URL belum diisi di index.html (masih placeholder "PASTE_URL_DEPLOY_APPS_SCRIPT_DISINI").';
            return;
        }

        try {
            const res = await fetch(url + '?action=getAll', { method: 'GET' });
            const rawText = await res.text();

            let json;
            try { json = JSON.parse(rawText); }
            catch (parseErr) {
                debugText.innerText =
                    `❌ Respons server BUKAN JSON (kemungkinan besar salah setting akses deployment).\n\n` +
                    `Status HTTP: ${res.status}\n` +
                    `Cuplikan respons:\n${rawText.slice(0, 300)}\n\n` +
                    `PERBAIKAN: Buka Apps Script → Deploy → Manage deployments → Edit (pensil) → ` +
                    `pastikan "Who has access" = Anyone, lalu klik Deploy lagi (bikin versi baru).`;
                this.setIndicator('err');
                return;
            }

            if (!json.ok) {
                debugText.innerText = `❌ Server merespons tapi ada error:\n${json.error}`;
                this.setIndicator('err');
                return;
            }

            debugText.innerText =
                `✅ Terhubung!\n` +
                `Dompet: ${json.data.wallets.length}\n` +
                `Transaksi: ${json.data.transactions.length}\n` +
                `Hutang/Piutang: ${json.data.debts.length}\n` +
                `Waktu server: ${json.data.serverTime}`;
            Store.replaceAll(json.data);
            AppMain.renderAll(true);
            this.setIndicator('ok');

        } catch (err) {
            debugText.innerText =
                `❌ Gagal menghubungi server sama sekali.\n\n` +
                `Pesan error: ${err.message}\n\n` +
                `Kemungkinan penyebab:\n` +
                `1. URL di index.html salah/typo\n` +
                `2. Tidak ada koneksi internet\n` +
                `3. Deployment Apps Script belum di-deploy ulang setelah edit kode`;
            this.setIndicator('err');
        }
    },

    async call(action, payload) {
        const url = this.getApiUrl();
        if (!url) throw new Error('API_URL_NOT_SET');
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify({ action, payload })
        });
        const json = await res.json();
        if (!json.ok) throw new Error(json.error || 'Unknown server error');
        return json.data;
    },

    async flushQueue() {
        if (this.flushing) return;
        if (!this.getApiUrl()) { this.setIndicator('off'); return; }
        if (!navigator.onLine) { this.setIndicator('off'); return; }
        if (this.queue.length === 0) { this.pull(); return; }

        this.flushing = true;
        this.setIndicator('syncing');

        while (this.queue.length > 0) {
            const item = this.queue[0];
            try {
                await this.call(item.action, item.payload);
                this.queue.shift();
                this.saveQueue();
            } catch (e) {
                console.warn('Sync failed, will retry:', e.message);
                this.flushing = false;
                this.setIndicator('err');
                clearTimeout(this.retryTimer);
                this.retryTimer = setTimeout(() => this.flushQueue(), 6000);
                return;
            }
        }
        this.flushing = false;
        await this.pull();
    },

    async pull() {
        const url = this.getApiUrl();
        if (!url) { this.setIndicator('off'); return; }
        if (!navigator.onLine) { this.setIndicator('off'); return; }
        if (this.queue.length > 0) { return this.flushQueue(); }

        this.setIndicator('syncing');
        try {
            const res = await fetch(url + '?action=getAll', { method: 'GET' });
            const json = await res.json();
            if (json.ok) {
                Store.replaceAll(json.data);
                AppMain.renderAll(true);
                this.setIndicator('ok');
            } else {
                this.setIndicator('err');
            }
        } catch (e) {
            console.warn('Pull failed:', e.message);
            this.setIndicator('err');
        }
    },

    startBackgroundLoop() {
        this.loadQueue();
        this.scheduleFlush();
        setInterval(() => { if (!this.flushing) this.flushQueue(); }, 45000);
        window.addEventListener('online', () => this.flushQueue());
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') this.flushQueue();
        });
    }
};

// ================== TOAST ==================
function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    document.getElementById('toast-msg').innerText = message;
    let icon = toast.querySelector('i');
    if (!icon) {
        // lucide.createIcons() sebelumnya sudah mengubah <i> jadi <svg>; buat ulang tag <i>
        const svg = toast.querySelector('svg');
        if (svg) svg.remove();
        icon = document.createElement('i');
        toast.insertBefore(icon, toast.firstChild);
    }
    icon.setAttribute('data-lucide', isError ? 'alert-circle' : 'check-circle');
    icon.className = 'w-5 h-5 flex-shrink-0 ' + (isError ? 'text-red-500' : 'text-emerald-500');
    lucide.createIcons();
    toast.classList.remove('opacity-0', 'translate-y-[-20px]', 'pointer-events-none');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.add('opacity-0', 'translate-y-[-20px]', 'pointer-events-none'), 3000);
}

// ================== UI HELPERS ==================
const UI = {
    balanceHidden: false,

    toggleBottomSheet(id) {
        const sheet = document.getElementById(id);
        const backdrop = document.getElementById('overlay-backdrop');
        const isClosed = sheet.classList.contains('translate-y-full');
        if (isClosed) {
            backdrop.classList.remove('hidden');
            setTimeout(() => backdrop.classList.remove('opacity-0'), 10);
            sheet.classList.remove('translate-y-full');
        } else {
            sheet.classList.add('translate-y-full');
            backdrop.classList.add('opacity-0');
            setTimeout(() => backdrop.classList.add('hidden'), 300);
        }
    },

    openModal(id) {
        const modal = document.getElementById(id);
        modal.classList.remove('hidden');
        modal.classList.add('flex');
        lucide.createIcons();
    },
    closeModal(id) {
        const modal = document.getElementById(id);
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    },
    closeAllOverlays() {
        ['sheet-create', 'sheet-export', 'sheet-backup'].forEach(id => {
            const sheet = document.getElementById(id);
            sheet.classList.add('translate-y-full');
        });
        const backdrop = document.getElementById('overlay-backdrop');
        backdrop.classList.add('opacity-0');
        setTimeout(() => backdrop.classList.add('hidden'), 300);
    },

    toggleBalanceVisibility() {
        this.balanceHidden = !this.balanceHidden;
        const icon = document.getElementById('balance-eye-icon');
        icon.setAttribute('data-lucide', this.balanceHidden ? 'eye-off' : 'eye');
        lucide.createIcons();
        AppMain.renderHome();
    }
};

// ================== NAVIGATION ==================
const Nav = {
    switch(pageId, navElement = null) {
        document.querySelectorAll('.page-view').forEach(p => p.classList.add('hidden'));
        document.getElementById(pageId).classList.remove('hidden');
        document.getElementById('pages-container').scrollTop = 0;

        if (navElement) {
            document.querySelectorAll('.nav-item').forEach(item => {
                item.classList.remove('text-theme');
                item.classList.add('text-text-muted');
            });
            navElement.classList.remove('text-text-muted');
            navElement.classList.add('text-theme');
        } else {
            // find matching nav item by page
            const map = { 'page-home': 0, 'page-transactions': 1, 'page-debts': 2, 'page-settings': 3 };
            const items = document.querySelectorAll('.nav-item');
            items.forEach(i => { i.classList.remove('text-theme'); i.classList.add('text-text-muted'); });
            if (map[pageId] !== undefined && items[map[pageId]]) {
                items[map[pageId]].classList.remove('text-text-muted');
                items[map[pageId]].classList.add('text-theme');
            }
        }
        lucide.createIcons();
        if (pageId === 'page-home') setTimeout(() => ChartModule.render(), 100);
        if (pageId === 'page-settings') Settings.renderPage();
    }
};

// ================== PIN LOGIC ==================
const Pin = {
    current: '',
    mode: 'unlock', // unlock | setup1 | setup2
    tempPin: '',

    init() {
        const hasPin = !!Store.state.settings.pinHash;
        this.mode = hasPin ? 'unlock' : 'setup1';
        this.current = '';
        this.updateSubtitle();
        this.updateDots();
    },

    updateSubtitle() {
        const sub = document.getElementById('pin-subtitle');
        if (this.mode === 'unlock') sub.innerText = 'Masukkan PIN Anda';
        else if (this.mode === 'setup1') sub.innerText = 'Buat PIN Baru (6 digit)';
        else sub.innerText = 'Ulangi PIN Baru';
    },

    enter(num) {
        if (this.current.length < 6) {
            this.current += num;
            this.updateDots();
            if (this.current.length === 6) this.verify();
        }
    },
    delete() {
        if (this.current.length > 0) {
            this.current = this.current.slice(0, -1);
            this.updateDots();
            document.getElementById('pin-error').style.opacity = '0';
        }
    },
    updateDots() {
        document.querySelectorAll('.pin-dot').forEach((dot, i) => {
            dot.classList.toggle('bg-theme', i < this.current.length);
            dot.classList.toggle('border-theme', i < this.current.length);
        });
    },

    async verify() {
        if (this.mode === 'unlock') {
            const hash = await sha256(this.current);
            if (hash === Store.state.settings.pinHash) {
                this.unlockSuccess();
            } else {
                this.fail('PIN Salah, coba lagi.');
            }
        } else if (this.mode === 'setup1') {
            this.tempPin = this.current;
            this.current = '';
            this.mode = 'setup2';
            this.updateSubtitle();
            this.updateDots();
        } else if (this.mode === 'setup2') {
            if (this.current === this.tempPin) {
                const hash = await sha256(this.current);
                Store.state.settings.pinHash = hash;
                Store.saveLocal();
                Sync.enqueue('updateSettings', { pinHash: hash });
                this.unlockSuccess();
            } else {
                this.fail('PIN tidak sama, ulangi dari awal.');
                this.mode = 'setup1';
            }
        }
    },

    fail(msg) {
        const dotsContainer = document.getElementById('pin-dots');
        dotsContainer.classList.add('shake');
        const err = document.getElementById('pin-error');
        err.innerText = msg;
        err.style.opacity = '1';
        setTimeout(() => {
            dotsContainer.classList.remove('shake');
            this.current = '';
            this.updateDots();
            if (this.mode !== 'unlock') this.updateSubtitle();
        }, 500);
    },

    unlockSuccess() {
        document.getElementById('pin-error').style.opacity = '0';
        document.getElementById('view-lock').classList.add('hidden');
        document.getElementById('view-main').classList.remove('hidden');
        document.getElementById('view-main').classList.add('flex');
        this.current = '';
        AppMain.renderAll();
        Nav.switch('page-home', document.querySelector('.nav-item'));
    },

    biometric() {
        showToast('Simulasi Sidik Jari Berhasil');
        if (this.mode === 'unlock') this.unlockSuccess();
    }
};

// ================== MAIN APP RENDERING ==================
const AppMain = {
    renderAll() {
        this.renderHome();
        TrxList.render();
        DebtList.render();
        Settings.renderPage();
        ChartModule.render();
        lucide.createIcons();
    },

    renderHome() {
        const s = Store.state;
        const settings = s.settings;
        document.getElementById('user-name-display').innerText = settings.userName || 'Pengguna';
        document.getElementById('avatar-initial').innerText = (settings.userName || 'P').charAt(0).toUpperCase();

        const totalBalance = s.wallets.reduce((sum, w) => sum + Number(w.balance || 0), 0);
        const mask = UI.balanceHidden;
        document.getElementById('total-balance').innerText = mask ? 'Rp ••••••••' : formatRupiah(totalBalance);

        const now = new Date();
        const thisMonth = now.getMonth(), thisYear = now.getFullYear();
        let income = 0, expense = 0;
        s.transactions.forEach(t => {
            const d = new Date(t.date);
            if (d.getMonth() === thisMonth && d.getFullYear() === thisYear) {
                if (t.type === 'income') income += Number(t.amount);
                else expense += Number(t.amount);
            }
        });
        document.getElementById('month-income').innerText = mask ? '••••••' : formatRupiah(income);
        document.getElementById('month-expense').innerText = mask ? '••••••' : formatRupiah(expense);

        this.renderWallets();
        this.renderRecentTransactions();
        lucide.createIcons();
    },

    renderWallets() {
        const container = document.getElementById('wallet-list-horizontal');
        if (!container) return;
        container.innerHTML = '';
        if (Store.state.wallets.length === 0) {
            container.innerHTML = '<div class="empty-state text-sm">Belum ada dompet.</div>';
            return;
        }
        Store.state.wallets.forEach(wallet => {
            container.innerHTML += `
                <div class="min-w-[140px] bg-surface border border-border rounded-3xl p-4 shadow-sm flex flex-col justify-between h-32 cursor-pointer" onclick="WalletModal.openEdit('${wallet.id}')">
                    <div class="flex justify-between items-start">
                        <div class="w-8 h-8 rounded-full ${wallet.color || 'bg-blue-500'} text-white flex items-center justify-center">
                            <i data-lucide="${wallet.icon || 'wallet'}" class="w-4 h-4"></i>
                        </div>
                        <span class="text-[10px] font-semibold text-text-muted bg-background px-2 py-1 rounded-full">${wallet.type || ''}</span>
                    </div>
                    <div>
                        <p class="text-xs text-text-muted mb-0.5">${wallet.name}</p>
                        <p class="font-bold text-sm text-text-main">${UI.balanceHidden ? 'Rp ••••••' : formatRupiah(wallet.balance)}</p>
                    </div>
                </div>`;
        });
        lucide.createIcons();
    },

    renderRecentTransactions() {
        const list = [...Store.state.transactions].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || ''))).slice(0, 3);
        TrxList.renderInto('recent-transactions-list', list);
    }
};

// ================== TRANSACTIONS ==================
const TrxList = {
    filter: 'all',

    setFilter(f, el) {
        this.filter = f;
        document.querySelectorAll('#trx-filter-chips button').forEach(b => {
            b.className = 'px-4 py-1.5 rounded-full bg-surface border border-border text-text-muted text-sm font-medium whitespace-nowrap';
        });
        el.className = 'px-4 py-1.5 rounded-full bg-theme text-white text-sm font-medium whitespace-nowrap';
        this.render();
    },

    render() {
        let data = [...Store.state.transactions].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
        const search = (document.getElementById('trx-search-input')?.value || '').toLowerCase();
        const now = new Date();

        if (this.filter === 'income') data = data.filter(t => t.type === 'income');
        else if (this.filter === 'expense') data = data.filter(t => t.type === 'expense');
        else if (this.filter === 'month') data = data.filter(t => {
            const d = new Date(t.date);
            return d.getMonth() === now.getMonth() && d.getFullYear() === now.getFullYear();
        });

        if (search) data = data.filter(t =>
            (t.category || '').toLowerCase().includes(search) ||
            (t.desc || '').toLowerCase().includes(search));

        this.renderInto('full-transactions-list', data);
    },

    renderInto(containerId, data) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.innerHTML = '';
        if (data.length === 0) {
            container.innerHTML = '<div class="empty-state"><i data-lucide="inbox" class="w-10 h-10 mx-auto mb-2"></i><p class="text-sm">Belum ada transaksi.</p></div>';
            lucide.createIcons();
            return;
        }
        data.forEach(trx => {
            const isIncome = trx.type === 'income';
            const colorClass = isIncome ? 'text-emerald-500' : 'text-text-main';
            const amountSign = isIncome ? '+' : '-';
            const bgIcon = isIncome ? 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-500' : 'bg-background text-text-muted';
            const wallet = Store.state.wallets.find(w => w.id === trx.walletId);
            const icon = CATEGORY_ICONS[trx.category] || 'circle-dollar-sign';
            container.innerHTML += `
                <div class="bg-surface border border-border p-4 rounded-2xl flex items-center justify-between shadow-sm active:scale-[0.98] transition-transform cursor-pointer" onclick="TrxModal.openDetail('${trx.id}')">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-full ${bgIcon} flex items-center justify-center"><i data-lucide="${icon}" class="w-6 h-6"></i></div>
                        <div>
                            <h4 class="font-bold text-sm">${trx.category}</h4>
                            <p class="text-xs text-text-muted">${wallet ? wallet.name : '-'} • ${trx.date}${trx.time ? ', ' + trx.time : ''}</p>
                            <p class="text-xs text-text-muted mt-0.5 max-w-[150px] truncate">${trx.desc || ''}</p>
                        </div>
                    </div>
                    <div class="text-right"><p class="font-bold text-sm ${colorClass}">${amountSign}${formatRupiah(trx.amount)}</p></div>
                </div>`;
        });
        lucide.createIcons();
    }
};

const TrxModal = {
    type: 'expense',
    editingId: null,
    photoBase64: null,

    open(type, quick = false) {
        this.editingId = null;
        this.photoBase64 = null;
        document.getElementById('modal-trx-title').innerText = quick ? 'Catat Cepat' : 'Tambah Transaksi';
        document.getElementById('btn-delete-trx').classList.add('hidden');
        document.getElementById('input-amount').value = '';
        document.getElementById('input-date').value = todayStr();
        document.getElementById('input-time').value = nowTimeStr();
        document.getElementById('input-desc').value = '';
        document.getElementById('photo-label').innerText = 'Ambil Foto';
        this.populateWallets();
        this.setTab(type);
        UI.openModal('modal-add-transaction');
    },

    openEdit(id) {
        const trx = Store.state.transactions.find(t => t.id === id);
        if (!trx) return;
        this.editingId = id;
        this.photoBase64 = null;
        document.getElementById('modal-trx-title').innerText = 'Edit Transaksi';
        document.getElementById('btn-delete-trx').classList.remove('hidden');
        document.getElementById('input-amount').value = trx.amount;
        document.getElementById('input-date').value = trx.date;
        document.getElementById('input-time').value = trx.time || '';
        document.getElementById('input-desc').value = trx.desc || '';
        document.getElementById('photo-label').innerText = trx.photoUrl ? 'Foto tersimpan (ganti?)' : 'Ambil Foto';
        this.populateWallets();
        this.setTab(trx.type);
        document.getElementById('select-wallet').value = trx.walletId;
        document.getElementById('select-category').value = trx.category;
        UI.openModal('modal-add-transaction');
    },

    populateWallets() {
        const sel = document.getElementById('select-wallet');
        sel.innerHTML = Store.state.wallets.map(w => `<option value="${w.id}">${w.name} (${formatRupiah(w.balance)})</option>`).join('');
    },

    setTab(type) {
        this.type = type;
        const btnInc = document.getElementById('btn-tab-income');
        const btnExp = document.getElementById('btn-tab-expense');
        if (type === 'income') {
            btnInc.className = 'flex-1 py-2 text-sm font-bold rounded-lg bg-emerald-500 text-white shadow-sm';
            btnExp.className = 'flex-1 py-2 text-sm font-bold rounded-lg text-text-muted hover:bg-background';
        } else {
            btnExp.className = 'flex-1 py-2 text-sm font-bold rounded-lg bg-red-500 text-white shadow-sm';
            btnInc.className = 'flex-1 py-2 text-sm font-bold rounded-lg text-text-muted hover:bg-background';
        }
        const selectCat = document.getElementById('select-category');
        selectCat.innerHTML = CATEGORIES[type].map(cat => `<option>${cat}</option>`).join('');
    },

    onPhotoSelected(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            this.photoBase64 = reader.result;
            document.getElementById('photo-label').innerText = 'Foto siap: ' + file.name;
        };
        reader.readAsDataURL(file);
    },

    save() {
        const amount = document.getElementById('input-amount').value;
        if (!amount || Number(amount) <= 0) { showToast('Masukkan nominal!', true); return; }
        const walletId = document.getElementById('select-wallet').value;
        if (!walletId) { showToast('Pilih dompet dulu!', true); return; }

        const payload = {
            type: this.type,
            amount: Number(amount),
            category: document.getElementById('select-category').value,
            walletId: walletId,
            date: document.getElementById('input-date').value || todayStr(),
            time: document.getElementById('input-time').value || nowTimeStr(),
            desc: document.getElementById('input-desc').value
        };

        if (this.editingId) {
            const old = Store.state.transactions.find(t => t.id === this.editingId);
            // revert old wallet balance
            adjustWalletLocal(old.walletId, old.type === 'income' ? -Number(old.amount) : Number(old.amount));
            Object.assign(old, payload);
            if (this.photoBase64) old.photoUrl = this.photoBase64;
            adjustWalletLocal(old.walletId, old.type === 'income' ? Number(old.amount) : -Number(old.amount));
            Store.saveLocal();
            Sync.enqueue('updateTransaction', Object.assign({ id: this.editingId }, payload, this.photoBase64 ? { photoUrl: this.photoBase64 } : {}));
            showToast('Transaksi berhasil diperbarui');
        } else {
            payload.id = uuid();
            payload.photoUrl = this.photoBase64 || '';
            Store.state.transactions.push(payload);
            adjustWalletLocal(payload.walletId, payload.type === 'income' ? Number(payload.amount) : -Number(payload.amount));
            Store.saveLocal();
            Sync.enqueue('addTransaction', payload);
            showToast('Transaksi berhasil disimpan');
        }

        UI.closeModal('modal-add-transaction');
        AppMain.renderHome();
        TrxList.render();
        ChartModule.render();
    },

    remove() {
        if (!this.editingId) return;
        this.removeById(this.editingId);
        UI.closeModal('modal-add-transaction');
    },

    removeById(id) {
        const trx = Store.state.transactions.find(t => t.id === id);
        if (!trx) return;
        adjustWalletLocal(trx.walletId, trx.type === 'income' ? -Number(trx.amount) : Number(trx.amount));
        Store.state.transactions = Store.state.transactions.filter(t => t.id !== id);
        Store.saveLocal();
        Sync.enqueue('deleteTransaction', { id });
        showToast('Transaksi dihapus');
        AppMain.renderHome();
        TrxList.render();
        ChartModule.render();
    },

    openDetail(id) {
        const trx = Store.state.transactions.find(t => t.id === id);
        if (!trx) return;
        this._detailId = id;
        const wallet = Store.state.wallets.find(w => w.id === trx.walletId);
        const isIncome = trx.type === 'income';
        document.getElementById('trx-detail-body').innerHTML = `
            <div class="text-center mb-4">
                <p class="text-text-muted text-sm mb-1">${trx.category}</p>
                <h2 class="text-3xl font-bold ${isIncome ? 'text-emerald-500' : 'text-text-main'}">${isIncome ? '+' : '-'}${formatRupiah(trx.amount)}</h2>
            </div>
            <div class="bg-background rounded-2xl p-4 flex flex-col gap-3 text-sm">
                <div class="flex justify-between"><span class="text-text-muted">Dompet</span><span class="font-medium">${wallet ? wallet.name : '-'}</span></div>
                <div class="flex justify-between"><span class="text-text-muted">Tanggal</span><span class="font-medium">${trx.date} ${trx.time || ''}</span></div>
                <div class="flex justify-between"><span class="text-text-muted">Catatan</span><span class="font-medium text-right max-w-[60%]">${trx.desc || '-'}</span></div>
            </div>
            ${trx.photoUrl ? `<img src="${trx.photoUrl}" class="w-full rounded-2xl mt-4 max-h-52 object-cover">` : ''}
        `;
        UI.openModal('modal-trx-detail');
    },
    editFromDetail() {
        UI.closeModal('modal-trx-detail');
        this.openEdit(this._detailId);
    },
    removeFromDetail() {
        UI.closeModal('modal-trx-detail');
        this.removeById(this._detailId);
    }
};

function adjustWalletLocal(walletId, delta) {
    const w = Store.state.wallets.find(w => w.id === walletId);
    if (w) w.balance = Number(w.balance || 0) + delta;
}

// ================== WALLETS ==================
const WalletModal = {
    editingId: null,

    openList() {
        this.renderList();
        UI.openModal('modal-wallet-list');
    },
    renderList() {
        const container = document.getElementById('wallet-full-list');
        container.innerHTML = '';
        if (Store.state.wallets.length === 0) {
            container.innerHTML = '<div class="empty-state">Belum ada dompet. Tambahkan sekarang.</div>';
        }
        Store.state.wallets.forEach(w => {
            container.innerHTML += `
                <div class="bg-background rounded-2xl p-4 flex items-center justify-between cursor-pointer" onclick="WalletModal.openEdit('${w.id}')">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-full ${w.color} text-white flex items-center justify-center"><i data-lucide="${w.icon}" class="w-5 h-5"></i></div>
                        <div><p class="font-bold text-sm">${w.name}</p><p class="text-xs text-text-muted">${w.type}</p></div>
                    </div>
                    <p class="font-bold text-sm">${formatRupiah(w.balance)}</p>
                </div>`;
        });
        lucide.createIcons();
    },

    openAdd() {
        this.editingId = null;
        document.getElementById('wallet-form-title').innerText = 'Tambah Dompet';
        document.getElementById('wallet-name').value = '';
        document.getElementById('wallet-type').value = 'Bank';
        document.getElementById('wallet-balance').value = '';
        document.getElementById('btn-delete-wallet').classList.add('hidden');
        UI.openModal('modal-wallet-form');
    },
    openEdit(id) {
        const w = Store.state.wallets.find(w => w.id === id);
        if (!w) return;
        this.editingId = id;
        document.getElementById('wallet-form-title').innerText = 'Edit Dompet';
        document.getElementById('wallet-name').value = w.name;
        document.getElementById('wallet-type').value = w.type;
        document.getElementById('wallet-balance').value = w.balance;
        document.getElementById('btn-delete-wallet').classList.remove('hidden');
        UI.openModal('modal-wallet-form');
    },

    save() {
        const name = document.getElementById('wallet-name').value.trim();
        if (!name) { showToast('Nama dompet wajib diisi!', true); return; }
        const type = document.getElementById('wallet-type').value;
        const balance = Number(document.getElementById('wallet-balance').value) || 0;

        if (this.editingId) {
            const w = Store.state.wallets.find(w => w.id === this.editingId);
            Object.assign(w, { name, type, balance });
            Store.saveLocal();
            Sync.enqueue('updateWallet', { id: this.editingId, name, type, balance });
            showToast('Dompet diperbarui');
        } else {
            const w = { id: uuid(), name, type, balance, color: WALLET_COLOR_MAP[type] || 'bg-gray-500', icon: WALLET_ICON_MAP[type] || 'wallet' };
            Store.state.wallets.push(w);
            Store.saveLocal();
            Sync.enqueue('addWallet', w);
            showToast('Dompet ditambahkan');
        }
        UI.closeModal('modal-wallet-form');
        this.renderList();
        AppMain.renderHome();
    },

    remove() {
        if (!this.editingId) return;
        if (Store.state.transactions.some(t => t.walletId === this.editingId)) {
            showToast('Tidak bisa hapus, dompet masih punya transaksi.', true);
            return;
        }
        Store.state.wallets = Store.state.wallets.filter(w => w.id !== this.editingId);
        Store.saveLocal();
        Sync.enqueue('deleteWallet', { id: this.editingId });
        showToast('Dompet dihapus');
        UI.closeModal('modal-wallet-form');
        this.renderList();
        AppMain.renderHome();
    }
};

// ================== DEBTS ==================
const DebtList = {
    filter: 'all',
    setFilter(f, el) {
        this.filter = f;
        document.querySelectorAll('[data-debt-filter]').forEach(b => {
            b.className = 'flex-1 py-2 text-sm font-medium rounded-lg text-text-muted';
        });
        el.className = 'flex-1 py-2 text-sm font-medium rounded-lg bg-theme text-white shadow-sm';
        this.render();
    },
    render() {
        const debts = Store.state.debts;
        let data = [...debts];
        if (this.filter === 'unpaid') data = data.filter(d => d.status !== 'Lunas');

        const hutang = debts.filter(d => d.type === 'hutang' && d.status !== 'Lunas').reduce((s, d) => s + Number(d.amount), 0);
        const piutang = debts.filter(d => d.type === 'piutang' && d.status !== 'Lunas').reduce((s, d) => s + Number(d.amount), 0);
        document.getElementById('total-hutang').innerText = formatRupiah(hutang);
        document.getElementById('total-piutang').innerText = formatRupiah(piutang);

        const container = document.getElementById('debt-list');
        container.innerHTML = '';
        if (data.length === 0) {
            container.innerHTML = '<div class="empty-state"><i data-lucide="handshake" class="w-10 h-10 mx-auto mb-2"></i><p class="text-sm">Belum ada catatan hutang/piutang.</p></div>';
            lucide.createIcons();
            return;
        }
        data.forEach(debt => {
            const isPiutang = debt.type === 'piutang';
            const colorClass = isPiutang ? 'text-emerald-500' : 'text-red-500';
            container.innerHTML += `
                <div class="bg-surface border border-border p-4 rounded-2xl flex items-center justify-between shadow-sm">
                    <div class="flex items-center gap-3 cursor-pointer flex-1" onclick="DebtModal.openPay('${debt.id}')">
                        <div class="w-10 h-10 rounded-full bg-background flex items-center justify-center font-bold text-text-muted">${(debt.name || '?').charAt(0)}</div>
                        <div>
                            <h4 class="font-bold text-sm">${debt.name}</h4>
                            <p class="text-xs text-text-muted">${debt.dueDate ? 'Jatuh tempo: ' + debt.dueDate : (debt.note || '')}</p>
                        </div>
                    </div>
                    <div class="text-right flex items-center gap-2">
                        <div>
                            <p class="font-bold text-sm ${colorClass}">${formatRupiah(debt.amount)}</p>
                            <span class="text-[10px] font-medium px-2 py-0.5 rounded-full ${isPiutang ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30' : 'bg-red-100 text-red-700 dark:bg-red-900/30'}">${debt.status}</span>
                        </div>
                        <button class="p-2 text-text-muted" onclick="DebtModal.openEdit('${debt.id}')"><i data-lucide="pencil" class="w-4 h-4"></i></button>
                    </div>
                </div>`;
        });
        lucide.createIcons();
    }
};

const DebtModal = {
    type: 'hutang',
    editingId: null,
    payingId: null,

    setType(type) {
        this.type = type;
        const bH = document.getElementById('btn-debt-hutang'), bP = document.getElementById('btn-debt-piutang');
        if (type === 'hutang') {
            bH.className = 'flex-1 py-2 text-sm font-bold rounded-lg bg-red-500 text-white shadow-sm';
            bP.className = 'flex-1 py-2 text-sm font-bold rounded-lg text-text-muted';
        } else {
            bP.className = 'flex-1 py-2 text-sm font-bold rounded-lg bg-emerald-500 text-white shadow-sm';
            bH.className = 'flex-1 py-2 text-sm font-bold rounded-lg text-text-muted';
        }
    },

    openAdd() {
        this.editingId = null;
        document.getElementById('debt-form-title').innerText = 'Catat Hutang/Piutang';
        document.getElementById('debt-name').value = '';
        document.getElementById('debt-amount').value = '';
        document.getElementById('debt-duedate').value = '';
        document.getElementById('debt-note').value = '';
        document.getElementById('btn-delete-debt').classList.add('hidden');
        this.setType('hutang');
        UI.openModal('modal-debt-form');
    },
    openEdit(id) {
        const d = Store.state.debts.find(d => d.id === id);
        if (!d) return;
        this.editingId = id;
        document.getElementById('debt-form-title').innerText = 'Edit Hutang/Piutang';
        document.getElementById('debt-name').value = d.name;
        document.getElementById('debt-amount').value = d.amount;
        document.getElementById('debt-duedate').value = d.dueDate || '';
        document.getElementById('debt-note').value = d.note || '';
        document.getElementById('btn-delete-debt').classList.remove('hidden');
        this.setType(d.type);
        UI.openModal('modal-debt-form');
    },

    save() {
        const name = document.getElementById('debt-name').value.trim();
        const amount = Number(document.getElementById('debt-amount').value);
        if (!name || !amount) { showToast('Nama & nominal wajib diisi!', true); return; }
        const dueDate = document.getElementById('debt-duedate').value;
        const note = document.getElementById('debt-note').value;

        if (this.editingId) {
            const d = Store.state.debts.find(d => d.id === this.editingId);
            Object.assign(d, { name, amount, type: this.type, dueDate, note });
            Store.saveLocal();
            Sync.enqueue('updateDebt', { id: this.editingId, name, amount, type: this.type, dueDate, note });
            showToast('Data diperbarui');
        } else {
            const d = { id: uuid(), name, amount, originalAmount: amount, type: this.type, status: 'Belum Lunas', dueDate, note };
            Store.state.debts.push(d);
            Store.saveLocal();
            Sync.enqueue('addDebt', d);
            showToast('Data tersimpan');
        }
        UI.closeModal('modal-debt-form');
        DebtList.render();
    },

    remove() {
        if (!this.editingId) return;
        Store.state.debts = Store.state.debts.filter(d => d.id !== this.editingId);
        Store.saveLocal();
        Sync.enqueue('deleteDebt', { id: this.editingId });
        showToast('Data dihapus');
        UI.closeModal('modal-debt-form');
        DebtList.render();
    },

    openPay(id) {
        const d = Store.state.debts.find(d => d.id === id);
        if (!d || d.status === 'Lunas') { this.openEdit(id); return; }
        this.payingId = id;
        document.getElementById('debt-pay-info').innerText =
            `${d.type === 'piutang' ? 'Menerima dari' : 'Membayar ke'} ${d.name} • Sisa ${formatRupiah(d.amount)}`;
        document.getElementById('debt-pay-amount').value = d.amount;
        const sel = document.getElementById('debt-pay-wallet');
        sel.innerHTML = Store.state.wallets.map(w => `<option value="${w.id}">${w.name} (${formatRupiah(w.balance)})</option>`).join('');
        UI.openModal('modal-debt-pay');
    },

    pay() {
        const d = Store.state.debts.find(d => d.id === this.payingId);
        if (!d) return;
        const payAmount = Number(document.getElementById('debt-pay-amount').value);
        const walletId = document.getElementById('debt-pay-wallet').value;
        if (!payAmount || payAmount <= 0) { showToast('Masukkan jumlah!', true); return; }

        const remaining = Math.max(0, Number(d.amount) - payAmount);
        d.amount = remaining;
        d.status = remaining === 0 ? 'Lunas' : 'Sebagian';

        const trxType = d.type === 'piutang' ? 'income' : 'expense';
        const trx = {
            id: uuid(), type: trxType, amount: payAmount,
            category: d.type === 'piutang' ? 'Pembayaran Piutang' : 'Bayar Hutang',
            walletId, date: todayStr(), time: nowTimeStr(), desc: 'Pembayaran: ' + d.name, photoUrl: ''
        };
        Store.state.transactions.push(trx);
        adjustWalletLocal(walletId, trxType === 'income' ? payAmount : -payAmount);
        Store.saveLocal();

        Sync.enqueue('payDebt', { id: d.id, payAmount, walletId, date: trx.date, time: trx.time });

        showToast('Pembayaran dicatat');
        UI.closeModal('modal-debt-pay');
        DebtList.render();
        AppMain.renderHome();
        TrxList.render();
        ChartModule.render();
    }
};

// ================== SETTINGS ==================
const Settings = {
    renderPage() {
        const s = Store.state.settings;
        document.getElementById('settings-user-name').innerText = s.userName || 'Pengguna';
        document.getElementById('settings-avatar').innerText = (s.userName || 'P').charAt(0).toUpperCase();
        document.getElementById('theme-toggle').checked = document.documentElement.classList.contains('dark');

        const statusEl = document.getElementById('api-status-text');
        if (statusEl) {
            const url = Sync.getApiUrl();
            if (!url) {
                statusEl.innerText = 'Belum diatur (edit API_URL di index.html)';
                statusEl.className = 'text-xs text-red-500';
            } else if (Sync.lastStatus === 'ok') {
                statusEl.innerText = 'Terhubung ✓';
                statusEl.className = 'text-xs text-emerald-500';
            } else if (Sync.lastStatus === 'err') {
                statusEl.innerText = 'Gagal terhubung, akan dicoba lagi otomatis';
                statusEl.className = 'text-xs text-red-500';
            } else {
                statusEl.innerText = 'Mengecek koneksi...';
                statusEl.className = 'text-xs text-text-muted';
            }
        }

        const hint = document.getElementById('pwa-install-hint');
        if (window.matchMedia('(display-mode: standalone)').matches) {
            hint.innerText = 'Berjalan sebagai aplikasi terinstall ✓';
        } else if (window.deferredInstallPrompt) {
            hint.innerHTML = '<button class="text-theme font-semibold underline" onclick="PWA.install()">Install aplikasi ini ke perangkat</button>';
        } else {
            hint.innerText = '';
        }
    },

    editName() {
        const name = prompt('Nama Anda:', Store.state.settings.userName || '');
        if (name && name.trim()) {
            Store.state.settings.userName = name.trim();
            Store.saveLocal();
            Sync.enqueue('updateSettings', { userName: name.trim() });
            this.renderPage();
            AppMain.renderHome();
        }
    },

    toggleDark() {
        document.documentElement.classList.toggle('dark');
        const isDark = document.documentElement.classList.contains('dark');
        Store.state.settings.darkMode = String(isDark);
        Store.saveLocal();
        Sync.enqueue('updateSettings', { darkMode: String(isDark) });
        ChartModule.render();
    },

    setColor(color) {
        document.body.classList.remove('theme-blue', 'theme-emerald', 'theme-purple', 'theme-orange', 'theme-red');
        if (color !== 'blue') document.body.classList.add(`theme-${color}`);
        Store.state.settings.themeColor = color;
        Store.saveLocal();
        Sync.enqueue('updateSettings', { themeColor: color });
        ChartModule.render();
    },

    async changePin() {
        const oldPin = document.getElementById('old-pin').value;
        const newPin = document.getElementById('new-pin').value;
        const confirmPin = document.getElementById('new-pin-confirm').value;
        if (!/^\d{6}$/.test(newPin)) { showToast('PIN baru harus 6 digit angka', true); return; }
        if (newPin !== confirmPin) { showToast('Konfirmasi PIN tidak cocok', true); return; }
        const oldHash = await sha256(oldPin);
        if (oldHash !== Store.state.settings.pinHash) { showToast('PIN lama salah', true); return; }
        const newHash = await sha256(newPin);
        Store.state.settings.pinHash = newHash;
        Store.saveLocal();
        Sync.enqueue('updateSettings', { pinHash: newHash });
        UI.closeModal('modal-pin-change');
        showToast('PIN berhasil diganti');
        document.getElementById('old-pin').value = '';
        document.getElementById('new-pin').value = '';
        document.getElementById('new-pin-confirm').value = '';
    },

    applyThemeFromSettings() {
        const s = Store.state.settings;
        if (s.darkMode === 'true') document.documentElement.classList.add('dark');
        if (s.themeColor && s.themeColor !== 'blue') document.body.classList.add(`theme-${s.themeColor}`);
    }
};

const PinChangeModal = { open() { UI.openModal('modal-pin-change'); } };

// ================== EXPORT / IMPORT / BACKUP ==================
const DataIO = {
    openExportSheet() { UI.toggleBottomSheet('sheet-export'); },
    openBackupSheet() { UI.toggleBottomSheet('sheet-backup'); },

    exportCsv() {
        const rows = [['Tanggal', 'Jam', 'Tipe', 'Kategori', 'Dompet', 'Nominal', 'Catatan']];
        Store.state.transactions.forEach(t => {
            const wallet = Store.state.wallets.find(w => w.id === t.walletId);
            rows.push([t.date, t.time || '', t.type === 'income' ? 'Pemasukan' : 'Pengeluaran', t.category, wallet ? wallet.name : '', t.amount, (t.desc || '').replace(/,/g, ';')]);
        });
        const csv = rows.map(r => r.join(',')).join('\n');
        downloadFile(csv, `nexwallet-transaksi-${todayStr()}.csv`, 'text/csv');
        showToast('CSV berhasil diunduh');
        UI.closeAllOverlays();
    },

    exportPdf() {
        const s = Store.state;
        const rowsHtml = [...s.transactions].sort((a, b) => b.date.localeCompare(a.date)).map(t => {
            const wallet = s.wallets.find(w => w.id === t.walletId);
            return `<tr><td>${t.date} ${t.time || ''}</td><td>${t.type === 'income' ? 'Pemasukan' : 'Pengeluaran'}</td><td>${t.category}</td><td>${wallet ? wallet.name : ''}</td><td style="text-align:right">${formatRupiah(t.amount)}</td></tr>`;
        }).join('');
        const win = window.open('', '_blank');
        win.document.write(`
            <html><head><title>Laporan Transaksi NexWallet</title>
            <style>body{font-family:Arial,sans-serif;padding:24px;} h1{font-size:18px;} table{width:100%;border-collapse:collapse;margin-top:16px;} th,td{border:1px solid #ddd;padding:8px;font-size:12px;text-align:left;} th{background:#f3f4f6;}</style>
            </head><body>
            <h1>Laporan Transaksi — NexWallet</h1>
            <p>Dicetak: ${new Date().toLocaleString('id-ID')}</p>
            <table><thead><tr><th>Tanggal</th><th>Tipe</th><th>Kategori</th><th>Dompet</th><th>Nominal</th></tr></thead>
            <tbody>${rowsHtml}</tbody></table>
            </body></html>`);
        win.document.close();
        setTimeout(() => win.print(), 400);
        UI.closeAllOverlays();
    },

    backup() {
        const data = JSON.stringify(Store.state, null, 2);
        downloadFile(data, `nexwallet-backup-${todayStr()}.json`, 'application/json');
        showToast('Backup berhasil diunduh');
        UI.closeAllOverlays();
    },

    importFile(e) {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                const data = JSON.parse(reader.result);
                if (!confirm('Import akan MENIMPA seluruh data saat ini. Lanjutkan?')) return;
                Store.state = {
                    wallets: data.wallets || [],
                    transactions: data.transactions || [],
                    debts: data.debts || [],
                    settings: Object.assign({}, Store.state.settings, data.settings || {})
                };
                Store.saveLocal();
                Sync.enqueue('restoreData', Store.state);
                AppMain.renderAll();
                showToast('Data berhasil diimport');
            } catch (err) {
                showToast('File tidak valid', true);
            }
        };
        reader.readAsText(file);
        e.target.value = '';
        UI.closeAllOverlays();
    }
};

function downloadFile(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ================== CHART ==================
const ChartModule = {
    instance: null,
    render() {
        const ctx = document.getElementById('mainChart');
        if (!ctx) return;
        if (this.instance) this.instance.destroy();

        const isDark = document.documentElement.classList.contains('dark');
        const textColor = isDark ? '#9ca3af' : '#6b7280';
        const gridColor = isDark ? '#374151' : '#e5e7eb';
        const style = getComputedStyle(document.body);
        let themeColor = style.getPropertyValue('--color-theme').trim() || '#3b82f6';

        const months = [];
        const incomeData = [];
        const expenseData = [];
        const now = new Date();
        for (let i = 5; i >= 0; i--) {
            const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
            months.push(d.toLocaleDateString('id-ID', { month: 'short' }));
            const m = d.getMonth(), y = d.getFullYear();
            let inc = 0, exp = 0;
            Store.state.transactions.forEach(t => {
                const td = new Date(t.date);
                if (td.getMonth() === m && td.getFullYear() === y) {
                    if (t.type === 'income') inc += Number(t.amount); else exp += Number(t.amount);
                }
            });
            incomeData.push(inc);
            expenseData.push(exp);
        }

        this.instance = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: months,
                datasets: [
                    { label: 'Pemasukan', data: incomeData, backgroundColor: '#10b981', borderRadius: 6, barPercentage: 0.6, categoryPercentage: 0.8 },
                    { label: 'Pengeluaran', data: expenseData, backgroundColor: '#ef4444', borderRadius: 6, barPercentage: 0.6, categoryPercentage: 0.8 }
                ]
            },
            options: {
                responsive: true, maintainAspectRatio: false,
                plugins: {
                    legend: { display: false },
                    tooltip: { mode: 'index', intersect: false, backgroundColor: isDark ? '#1f2937' : '#ffffff', titleColor: isDark ? '#f9fafb' : '#111827', bodyColor: textColor, borderColor: gridColor, borderWidth: 1, padding: 10, boxPadding: 4 }
                },
                scales: {
                    x: { grid: { display: false }, ticks: { color: textColor, font: { family: 'Inter', size: 10 } } },
                    y: { grid: { color: gridColor, borderDash: [5, 5] }, ticks: { display: false } }
                },
                interaction: { mode: 'nearest', axis: 'x', intersect: false }
            }
        });
    }
};

// ================== PWA INSTALL ==================
const PWA = {
    install() {
        if (!window.deferredInstallPrompt) return;
        window.deferredInstallPrompt.prompt();
        window.deferredInstallPrompt.userChoice.then(() => { window.deferredInstallPrompt = null; });
    }
};
window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    window.deferredInstallPrompt = e;
    Settings.renderPage();
});

// ================== APP BOOT ==================
const App = {
    logout() {
        document.getElementById('view-main').classList.add('hidden');
        document.getElementById('view-main').classList.remove('flex');
        document.getElementById('view-lock').classList.remove('hidden');
        Pin.init();
    },

    init() {
        Store.loadLocal();
        Settings.applyThemeFromSettings();
        Pin.init();
        lucide.createIcons();

        // Register service worker for PWA (installable + offline shell)
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW register failed:', err));
            });
        }

        // Background sync starts immediately, never blocks the UI
        Sync.startBackgroundLoop();
    }
};

document.addEventListener('DOMContentLoaded', () => App.init());
