/* ============================================
   GESTÃO BE E MILA - Application Logic v2.1
   SEGURANÇA REFORÇADA
   ============================================ */

// ===== SUPABASE CONFIG =====
const SUPABASE_URL = 'https://xvuspozypouhrjhlgbqv.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_s8RlVo0V54IBl4lHvi9RyA_ZVM6vFr2';
let supabaseClient = null, useSupabase = false;
try { supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY); useSupabase = true; } catch (e) { useSupabase = false; }

// ===== SECURITY: SHA-256 Hashing =====
async function hashPassword(password) {
    const encoder = new TextEncoder();
    const data = encoder.encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ===== SECURITY: XSS Protection =====
function escapeHtml(str) {
    if (!str) return '';
    const s = String(str);
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

// ===== SECURITY: Rate Limiting =====
const loginRateLimit = { attempts: 0, lastAttempt: 0, lockedUntil: 0 };
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION = 60000; // 60 seconds
function checkRateLimit() {
    const now = Date.now();
    if (loginRateLimit.lockedUntil > now) {
        const secsLeft = Math.ceil((loginRateLimit.lockedUntil - now) / 1000);
        return { blocked: true, message: `Muitas tentativas. Aguarde ${secsLeft}s.` };
    }
    if (now - loginRateLimit.lastAttempt > LOCKOUT_DURATION) {
        loginRateLimit.attempts = 0;
    }
    return { blocked: false };
}
function recordLoginAttempt(success) {
    const now = Date.now();
    if (success) { loginRateLimit.attempts = 0; loginRateLimit.lockedUntil = 0; return; }
    loginRateLimit.attempts++;
    loginRateLimit.lastAttempt = now;
    if (loginRateLimit.attempts >= MAX_LOGIN_ATTEMPTS) {
        loginRateLimit.lockedUntil = now + LOCKOUT_DURATION;
    }
}

// ===== SECURITY: Session Timeout (30 min) =====
let sessionTimer = null;
const SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes
function resetSessionTimer() {
    if (sessionTimer) clearTimeout(sessionTimer);
    if (!currentUser) return;
    sessionTimer = setTimeout(() => {
        if (currentUser) {
            currentUser = null; expenses = []; fixedCosts = [];
            document.getElementById('appContainer').classList.add('hidden');
            document.getElementById('loginScreen').classList.remove('hidden');
            document.getElementById('loginError').textContent = 'Sessão expirada. Faça login novamente.';
        }
    }, SESSION_TIMEOUT);
}
['click', 'keydown', 'mousemove', 'scroll'].forEach(evt => {
    document.addEventListener(evt, () => { if (currentUser) resetSessionTimer(); }, { passive: true });
});

// ===== APP STATE =====
let currentUser = null, currentUserHash = null, expenses = [], fixedCosts = [];
let userBalance = 0, userSavings = 0;
let savingsGoal = 0, savingsGoalDesc = '', creditCardLimit = 0, creditCardBill = 0;
let adminBalances = { marcos: 0, camila: 0 }, pendingUsers = [];
let dashCategoryChartInstance = null, evoMonthlyChartInstance = null;
let evoCategoryChartInstance = null, evoDailyChartInstance = null, ccGaugeChartInstance = null;

const CATEGORIES = {
    alimentacao: { label: 'Alimentação', emoji: '🍽️', color: '#ff6b6b' },
    transporte: { label: 'Transporte', emoji: '🚗', color: '#ffd93d' },
    moradia: { label: 'Moradia', emoji: '🏠', color: '#667eea' },
    saude: { label: 'Saúde', emoji: '💊', color: '#4ecdc4' },
    educacao: { label: 'Educação', emoji: '📚', color: '#74b9ff' },
    lazer: { label: 'Lazer', emoji: '🎮', color: '#f093fb' },
    vestuario: { label: 'Vestuário', emoji: '👕', color: '#a8edea' },
    servicos: { label: 'Serviços', emoji: '🔧', color: '#fdcb6e' },
    outros: { label: 'Outros', emoji: '📦', color: '#b2bec3' }
};

function getCategoryInfo(k) { return CATEGORIES[k] || { label: k, emoji: '📦', color: '#b2bec3' }; }
function formatCurrency(v) { return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v); }
function formatDate(d) { return new Date(d + 'T00:00:00').toLocaleDateString('pt-BR'); }
function getCurrentMonthStr() { const n = new Date(); return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`; }
function generateId() { return Date.now().toString(36) + Math.random().toString(36).substr(2, 9); }
function isAdmin() { return currentUser && (currentUser.is_admin || currentUser.shared_with); }
function isMainAdmin() { return currentUser && currentUser.username === 'marcos'; }
function getAdminUsers() {
    if (currentUser && currentUser.is_admin) return ['marcos', 'camila'];
    if (currentUser && currentUser.shared_with) return [currentUser.username, currentUser.shared_with];
    return [currentUser ? currentUser.username : ''];
}

// ===== STORAGE FUNCTIONS =====
async function loadExpenses() {
    if (useSupabase) {
        try {
            let query = supabaseClient.from('expenses').select('*').order('expense_date', { ascending: false });
            if (!isAdmin()) query = query.eq('user_name', currentUser.username);
            else query = query.in('user_name', getAdminUsers());
            const { data, error } = await query;
            if (error) throw error;
            expenses = data || []; return;
        } catch (e) { console.warn('Supabase load failed:', e); }
    }
    if (isAdmin()) {
        const m = JSON.parse(localStorage.getItem('bemila_expenses_marcos') || '[]');
        const c = JSON.parse(localStorage.getItem('bemila_expenses_camila') || '[]');
        expenses = [...m, ...c].sort((a, b) => (b.expense_date || '').localeCompare(a.expense_date || ''));
    } else {
        expenses = JSON.parse(localStorage.getItem(`bemila_expenses_${currentUser.username}`) || '[]');
    }
}

async function saveExpense(expense) {
    if (useSupabase) {
        try {
            if (expense._isEdit && expense.id) {
                const { error } = await supabaseClient.from('expenses').update({
                    description: expense.description, category: expense.category,
                    amount: expense.amount, expense_date: expense.expense_date,
                    payment_method: expense.payment_method || 'debit',
                    paid_by: expense.paid_by || currentUser.username
                }).eq('id', expense.id);
                if (error) throw error;
            } else {
                const { data, error } = await supabaseClient.from('expenses').insert({
                    user_name: isAdmin() ? (expense.paid_by || currentUser.username) : currentUser.username,
                    description: expense.description, category: expense.category,
                    amount: parseFloat(expense.amount), expense_date: expense.expense_date,
                    payment_method: expense.payment_method || 'debit',
                    paid_by: expense.paid_by || currentUser.username
                }).select();
                if (error) throw error;
                if (data && data[0]) expense.id = data[0].id;
            }
            await loadExpenses(); return;
        } catch (e) { console.warn('Supabase save failed:', e); }
    }
    const idx = expenses.findIndex(e => e.id === expense.id);
    if (idx > -1) { expenses[idx] = { ...expenses[idx], ...expense }; }
    else { expense.id = generateId(); expense.user_name = currentUser.username; expense.created_at = new Date().toISOString(); expenses.unshift(expense); }
    const key = isAdmin() ? `bemila_expenses_${expense.paid_by || currentUser.username}` : `bemila_expenses_${currentUser.username}`;
    localStorage.setItem(key, JSON.stringify(expenses.filter(e => e.user_name === (expense.paid_by || currentUser.username))));
}

async function deleteExpense(id) {
    if (useSupabase) {
        try { const { error } = await supabaseClient.from('expenses').delete().eq('id', id); if (error) throw error; await loadExpenses(); return; } catch (e) { }
    }
    expenses = expenses.filter(e => e.id !== id);
    localStorage.setItem(`bemila_expenses_${currentUser.username}`, JSON.stringify(expenses));
}

async function loadBalance() {
    if (useSupabase) {
        try {
            if (isAdmin()) {
                const { data } = await supabaseClient.from('balances').select('amount, user_name').in('user_name', getAdminUsers());
                adminBalances = { marcos: 0, camila: 0 };
                (data || []).forEach(r => { adminBalances[r.user_name] = parseFloat(r.amount || 0); });
                userBalance = adminBalances.marcos + adminBalances.camila;
            } else {
                const { data } = await supabaseClient.from('balances').select('amount').eq('user_name', currentUser.username);
                userBalance = (data && data[0]) ? parseFloat(data[0].amount || 0) : 0;
            }
            return;
        } catch (e) { }
    }
    if (isAdmin()) {
        adminBalances.marcos = parseFloat(localStorage.getItem('bemila_balance_marcos') || '0');
        adminBalances.camila = parseFloat(localStorage.getItem('bemila_balance_camila') || '0');
        userBalance = adminBalances.marcos + adminBalances.camila;
    } else {
        userBalance = parseFloat(localStorage.getItem(`bemila_balance_${currentUser.username}`) || '0');
    }
}

async function saveBalance(amount, targetUser) {
    const user = targetUser || currentUser.username;
    const val = parseFloat(amount);
    if (useSupabase) {
        try {
            const { data: existing } = await supabaseClient.from('balances').select('id').eq('user_name', user).single();
            if (existing) await supabaseClient.from('balances').update({ amount: val, updated_at: new Date().toISOString() }).eq('user_name', user);
            else await supabaseClient.from('balances').insert({ user_name: user, amount: val });
            await loadBalance(); return;
        } catch (e) { }
    }
    localStorage.setItem(`bemila_balance_${user}`, val.toString());
    if (isAdmin()) { adminBalances[user] = val; userBalance = adminBalances.marcos + adminBalances.camila; }
    else userBalance = val;
}

async function loadSavings() {
    if (useSupabase) {
        try {
            let query = supabaseClient.from('savings').select('*');
            if (!isAdmin()) query = query.eq('user_name', currentUser.username);
            const { data, error } = await query;
            if (error) throw error;
            if (data && data.length > 0) {
                userSavings = data.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
                const g = data.find(r => r.goal_amount > 0) || data[0];
                savingsGoal = parseFloat(g.goal_amount) || 0;
                savingsGoalDesc = g.goal_description || '';
            } else { userSavings = 0; savingsGoal = 0; savingsGoalDesc = ''; }
            return;
        } catch (e) { }
    }
    if (isAdmin()) {
        let ts = 0, ga = 0, gd = '';
        ['marcos', 'camila'].forEach(u => { const s = localStorage.getItem(`bemila_savings_${u}`); if (s) { const p = JSON.parse(s); ts += p.amount || 0; if (p.goal_amount > 0 && ga === 0) { ga = p.goal_amount; gd = p.goal_description || ''; } } });
        userSavings = ts; savingsGoal = ga; savingsGoalDesc = gd;
    } else {
        const s = localStorage.getItem(`bemila_savings_${currentUser.username}`);
        if (s) { const p = JSON.parse(s); userSavings = p.amount || 0; savingsGoal = p.goal_amount || 0; savingsGoalDesc = p.goal_description || ''; }
        else { userSavings = 0; savingsGoal = 0; savingsGoalDesc = ''; }
    }
}

async function saveSavingsData() {
    if (useSupabase) {
        try {
            const { data: existing } = await supabaseClient.from('savings').select('id').eq('user_name', currentUser.username).single();
            const payload = { amount: userSavings, goal_amount: savingsGoal, goal_description: savingsGoalDesc, updated_at: new Date().toISOString() };
            if (existing) await supabaseClient.from('savings').update(payload).eq('user_name', currentUser.username);
            else await supabaseClient.from('savings').insert({ user_name: currentUser.username, ...payload });
            return;
        } catch (e) { }
    }
    localStorage.setItem(`bemila_savings_${currentUser.username}`, JSON.stringify({ amount: userSavings, goal_amount: savingsGoal, goal_description: savingsGoalDesc }));
}

// ===== FIXED COSTS =====
async function loadFixedCosts() {
    if (useSupabase) {
        try {
            let query = supabaseClient.from('fixed_costs').select('*').eq('is_active', true).order('due_day');
            if (!isAdmin()) query = query.eq('user_name', currentUser.username);
            else query = query.in('user_name', getAdminUsers());
            const { data, error } = await query;
            if (error) throw error;
            fixedCosts = data || []; return;
        } catch (e) { }
    }
    fixedCosts = JSON.parse(localStorage.getItem(`bemila_fixedcosts_${currentUser.username}`) || '[]');
}

async function saveFixedCost(fc) {
    if (useSupabase) {
        try {
            if (fc._isEdit && fc.id) {
                await supabaseClient.from('fixed_costs').update({ description: fc.description, category: fc.category, amount: fc.amount, due_day: fc.due_day }).eq('id', fc.id);
            } else {
                await supabaseClient.from('fixed_costs').insert({ user_name: currentUser.username, description: fc.description, category: fc.category, amount: parseFloat(fc.amount), due_day: parseInt(fc.due_day), is_active: true });
            }
            await loadFixedCosts(); return;
        } catch (e) { }
    }
    if (fc._isEdit) { const idx = fixedCosts.findIndex(f => f.id === fc.id); if (idx > -1) fixedCosts[idx] = { ...fixedCosts[idx], ...fc }; }
    else { fc.id = generateId(); fc.user_name = currentUser.username; fc.is_active = true; fixedCosts.push(fc); }
    localStorage.setItem(`bemila_fixedcosts_${currentUser.username}`, JSON.stringify(fixedCosts));
}

async function deleteFixedCost(id) {
    if (useSupabase) {
        try { await supabaseClient.from('fixed_costs').update({ is_active: false }).eq('id', id); await loadFixedCosts(); return; } catch (e) { }
    }
    fixedCosts = fixedCosts.filter(f => f.id !== id);
    localStorage.setItem(`bemila_fixedcosts_${currentUser.username}`, JSON.stringify(fixedCosts));
}

// ===== CREDIT CARD =====
async function loadCreditCard() {
    if (useSupabase) {
        try {
            const { data } = await supabaseClient.from('credit_cards').select('*').eq('user_name', currentUser.username).single();
            if (data) { creditCardLimit = parseFloat(data.card_limit) || 0; creditCardBill = parseFloat(data.current_bill) || 0; }
            else { creditCardLimit = 0; creditCardBill = 0; }
            return;
        } catch (e) { }
    }
    const s = localStorage.getItem(`bemila_creditcard_${currentUser.username}`);
    if (s) { const p = JSON.parse(s); creditCardLimit = p.card_limit || 0; creditCardBill = p.current_bill || 0; }
    else { creditCardLimit = 0; creditCardBill = 0; }
}

async function saveCreditCard() {
    if (useSupabase) {
        try {
            const { data: existing } = await supabaseClient.from('credit_cards').select('id').eq('user_name', currentUser.username).single();
            const payload = { card_limit: creditCardLimit, current_bill: creditCardBill, updated_at: new Date().toISOString() };
            if (existing) await supabaseClient.from('credit_cards').update(payload).eq('user_name', currentUser.username);
            else await supabaseClient.from('credit_cards').insert({ user_name: currentUser.username, ...payload });
            return;
        } catch (e) { }
    }
    localStorage.setItem(`bemila_creditcard_${currentUser.username}`, JSON.stringify({ card_limit: creditCardLimit, current_bill: creditCardBill }));
}

// ===== PENDING USERS (Admin Approval via RPC) =====
async function loadPendingUsers() {
    if (useSupabase && currentUserHash) {
        try {
            const { data, error } = await supabaseClient.rpc('get_pending_users', {
                p_admin_username: currentUser.username,
                p_admin_hash: currentUserHash
            });
            if (error) throw error;
            if (data && data.success) { pendingUsers = data.users || []; return; }
        } catch (e) { console.warn('RPC get_pending_users failed:', e); }
    }
    const stored = JSON.parse(localStorage.getItem('bemila_users') || '[]');
    pendingUsers = stored.filter(u => !u.is_approved);
}

async function approveUser(username) {
    if (useSupabase && currentUserHash) {
        try {
            const { data, error } = await supabaseClient.rpc('approve_user', {
                p_admin_username: currentUser.username,
                p_admin_hash: currentUserHash,
                p_target_username: username
            });
            if (error) throw error;
            await loadPendingUsers(); return;
        } catch (e) { }
    }
    const stored = JSON.parse(localStorage.getItem('bemila_users') || '[]');
    const idx = stored.findIndex(u => u.username === username);
    if (idx > -1) { stored[idx].is_approved = true; localStorage.setItem('bemila_users', JSON.stringify(stored)); }
    pendingUsers = stored.filter(u => !u.is_approved);
}

async function rejectUser(username) {
    if (useSupabase && currentUserHash) {
        try {
            const { data, error } = await supabaseClient.rpc('reject_user', {
                p_admin_username: currentUser.username,
                p_admin_hash: currentUserHash,
                p_target_username: username
            });
            if (error) throw error;
            await loadPendingUsers(); return;
        } catch (e) { }
    }
    const stored = JSON.parse(localStorage.getItem('bemila_users') || '[]');
    const filtered = stored.filter(u => u.username !== username);
    localStorage.setItem('bemila_users', JSON.stringify(filtered));
    pendingUsers = filtered.filter(u => !u.is_approved);
}

// ===== LOGIN / REGISTER =====
const loginScreen = document.getElementById('loginScreen');
const appContainer = document.getElementById('appContainer');
const loginForm = document.getElementById('loginForm');
const registerForm = document.getElementById('registerForm');
const loginError = document.getElementById('loginError');
const registerError = document.getElementById('registerError');

document.getElementById('btnShowRegister').addEventListener('click', () => {
    loginForm.classList.add('hidden'); registerForm.classList.remove('hidden');
    document.getElementById('btnShowRegister').classList.add('hidden');
    document.getElementById('btnShowLogin').classList.remove('hidden');
    loginError.textContent = '';
});
document.getElementById('btnShowLogin').addEventListener('click', () => {
    registerForm.classList.add('hidden'); loginForm.classList.remove('hidden');
    document.getElementById('btnShowLogin').classList.add('hidden');
    document.getElementById('btnShowRegister').classList.remove('hidden');
    registerError.textContent = '';
});

async function authenticateUser(username, passwordHash) {
    if (useSupabase) {
        try {
            const { data, error } = await supabaseClient.rpc('authenticate_user', {
                p_username: username,
                p_password_hash: passwordHash
            });
            if (error) throw error;
            if (!data || !data.success) {
                if (data && data.error === 'pending_approval') return { error: 'pending' };
                return null;
            }
            return {
                username: data.username, displayName: data.displayName || data.display_name,
                is_admin: data.is_admin, email: data.email, is_approved: data.is_approved
            };
        } catch (e) { console.warn('RPC auth failed:', e); }
    }
    // Fallback localStorage (senhas já devem ser hash)
    const stored = JSON.parse(localStorage.getItem('bemila_users') || '[]');
    const user = stored.find(u => u.username === username && u.passwordHash === passwordHash);
    if (user && !user.is_approved) return { error: 'pending' };
    return user || null;
}

async function registerUser(username, email, passwordHash, displayName, sharedWith) {
    if (useSupabase) {
        try {
            const { data, error } = await supabaseClient.rpc('register_user', {
                p_username: username,
                p_email: email,
                p_password_hash: passwordHash,
                p_display_name: displayName || username
            });
            if (error) throw error;
            if (!data || !data.success) {
                if (data && data.error === 'user_exists') return { error: 'Usuário ou email já existe!' };
                return { error: data ? data.error : 'Erro desconhecido' };
            }
            return { success: true };
        } catch (e) { return { error: 'Erro ao conectar: ' + e.message }; }
    }
    const stored = JSON.parse(localStorage.getItem('bemila_users') || '[]');
    if (stored.find(u => u.username === username)) return { error: 'Usuário já existe!' };
    stored.push({ username, email, passwordHash, displayName: displayName || username, is_admin: false, is_approved: false, shared_with: sharedWith || '' });
    localStorage.setItem('bemila_users', JSON.stringify(stored));
    return { success: true };
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Rate limiting check
    const rl = checkRateLimit();
    if (rl.blocked) { loginError.textContent = rl.message; return; }

    const username = document.getElementById('loginUser').value.trim().toLowerCase();
    const password = document.getElementById('loginPass').value;
    const passwordHash = await hashPassword(password);
    const user = await authenticateUser(username, passwordHash);

    if (user && user.error === 'pending') {
        recordLoginAttempt(false);
        loginError.textContent = 'Sua conta aguarda aprovação do administrador.';
        return;
    }
    if (user && !user.error) {
        recordLoginAttempt(true);
        currentUser = user;
        currentUserHash = passwordHash;
        loginError.textContent = '';
        loginScreen.classList.add('hidden'); appContainer.classList.remove('hidden');
        document.getElementById('sidebarUser').textContent = `Olá, ${escapeHtml(user.displayName)}`;
        resetSessionTimer();
        initApp();
    } else {
        recordLoginAttempt(false);
        const rl2 = checkRateLimit();
        if (rl2.blocked) { loginError.textContent = rl2.message; }
        else { loginError.textContent = `Usuário ou senha incorretos! (${MAX_LOGIN_ATTEMPTS - loginRateLimit.attempts} tentativas restantes)`; }
        loginForm.querySelector('.btn-login').style.animation = 'shake 0.4s ease';
        setTimeout(() => { loginForm.querySelector('.btn-login').style.animation = ''; }, 400);
    }
});

registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value.trim().toLowerCase();
    const email = document.getElementById('regEmail').value.trim().toLowerCase();
    const pass = document.getElementById('regPass').value;
    const passConfirm = document.getElementById('regPassConfirm').value;
    if (pass !== passConfirm) { registerError.textContent = 'As senhas não coincidem!'; return; }
    if (pass.length < 4) { registerError.textContent = 'Senha deve ter pelo menos 4 caracteres!'; return; }
    // Hash the password before sending
    const passwordHash = await hashPassword(pass);
    const sharedWith = document.getElementById('regSharedAccount').checked ? document.getElementById('regPartnerUsername').value.trim().toLowerCase() : '';
    const result = await registerUser(username, email, passwordHash, username, sharedWith);
    if (result.error) { registerError.textContent = result.error; return; }
    registerError.textContent = '';
    showToast('Conta criada! Aguarde aprovação do administrador.', 'info');
    document.getElementById('btnShowLogin').click();
    document.getElementById('loginUser').value = username;
});


// ===== SHARED ACCOUNT TOGGLE =====
const regSharedCheckbox = document.getElementById('regSharedAccount');
const sharedPartnerField = document.getElementById('sharedPartnerField');
if (regSharedCheckbox) {
    regSharedCheckbox.addEventListener('change', () => {
        if (regSharedCheckbox.checked) sharedPartnerField.classList.remove('hidden');
        else sharedPartnerField.classList.add('hidden');
    });
}

const shakeStyle = document.createElement('style');
shakeStyle.textContent = `@keyframes shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-8px)}40%,80%{transform:translateX(8px)}}`;
document.head.appendChild(shakeStyle);


// ===== GOOGLE LOGIN =====
const btnGoogleLogin = document.getElementById('btnGoogleLogin');
if (btnGoogleLogin) {
    btnGoogleLogin.addEventListener('click', async () => {
        if (!useSupabase) {
            loginError.textContent = 'Login com Google requer Supabase configurado.';
            return;
        }
        try {
            const { data, error } = await supabaseClient.auth.signInWithOAuth({
                provider: 'google',
                options: { redirectTo: window.location.origin }
            });
            if (error) throw error;
        } catch (e) {
            loginError.textContent = 'Erro ao conectar com Google: ' + e.message;
        }
    });
}

// Check for Google auth redirect on page load
async function checkGoogleAuth() {
    if (!useSupabase) return;
    try {
        const { data: { session } } = await supabaseClient.auth.getSession();
        if (session && session.user) {
            const googleUser = session.user;
            const username = googleUser.email.split('@')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
            // Check if user exists in our users table via RPC
            const passwordHash = await hashPassword(googleUser.id);
            const authResult = await authenticateUser(username, passwordHash);
            if (authResult && !authResult.error) {
                currentUser = authResult;
                currentUserHash = passwordHash;
                loginScreen.classList.add('hidden'); appContainer.classList.remove('hidden');
                document.getElementById('sidebarUser').textContent = 'Olá, ' + escapeHtml(authResult.displayName);
                resetSessionTimer(); initApp();
            } else {
                // Auto-register Google user
                const regResult = await registerUser(username, googleUser.email, passwordHash, googleUser.user_metadata.full_name || username, '');
                if (regResult.success) {
                    loginError.textContent = 'Conta Google criada! Aguarde aprovação do administrador.';
                } else if (regResult.error === 'Usuário ou email já existe!') {
                    // User exists but might have pending approval
                    loginError.textContent = 'Sua conta aguarda aprovação do administrador.';
                }
            }
        }
    } catch (e) { console.warn('Google auth check:', e); }
}
checkGoogleAuth();

// ===== LOGOUT =====
document.getElementById('btnLogout').addEventListener('click', () => {
    currentUser = null; currentUserHash = null; expenses = []; fixedCosts = []; userBalance = 0; userSavings = 0;
    savingsGoal = 0; savingsGoalDesc = ''; creditCardLimit = 0; creditCardBill = 0;
    adminBalances = { marcos: 0, camila: 0 }; pendingUsers = [];
    if (sessionTimer) clearTimeout(sessionTimer);
    appContainer.classList.add('hidden'); loginScreen.classList.remove('hidden');
    document.getElementById('loginUser').value = ''; document.getElementById('loginPass').value = '';
    loginError.textContent = '';
    document.querySelector('.main-content').scrollTop = 0;
});

// ===== NAVIGATION =====
document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
        e.preventDefault();
        const target = item.dataset.panel;
        document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
        item.classList.add('active');
        document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
        document.getElementById(`panel-${target}`).classList.add('active');
        document.querySelector('.main-content').scrollTop = 0;
        if (target === 'dashboard') updateDashboard();
        if (target === 'evolution') updateEvolution();
        if (target === 'ai-assistant') updateAIAssistant();
        if (target === 'expenses') renderExpensesTable();
        if (target === 'savings') updateSavingsPanel();
        if (target === 'fixed-costs') updateFixedCostsPanel();
        if (target === 'credit-card') updateCreditCardPanel();
        if (target === 'admin-users') updateAdminUsersPanel();
    });
});

// ===== INIT =====
async function initApp() {
    document.getElementById('headerDate').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    document.getElementById('filterMonth').value = getCurrentMonthStr();
    const adminNav = document.getElementById('navAdminUsers');
    if (isMainAdmin() && adminNav) adminNav.style.display = '';
    else if (adminNav) adminNav.style.display = 'none';
    if (isAdmin()) {
        document.getElementById('adminBalanceSection').classList.remove('hidden');
        document.getElementById('paidByGroup').style.display = '';
        document.getElementById('btnEditBalance').style.display = 'none';
    } else {
        document.getElementById('adminBalanceSection').classList.add('hidden');
        document.getElementById('paidByGroup').style.display = 'none';
        document.getElementById('btnEditBalance').style.display = '';
    }
    await Promise.all([loadExpenses(), loadBalance(), loadSavings(), loadFixedCosts(), loadCreditCard()]);
    if (isMainAdmin()) await loadPendingUsers();
    updateDashboard(); renderExpensesTable();
}

// ===== DASHBOARD =====
function getMonthExpenses() { return expenses.filter(e => e.expense_date && e.expense_date.startsWith(getCurrentMonthStr())); }

function updateDashboard() {
    const monthExps = getMonthExpenses();
    const totalExpenses = monthExps.reduce((s, e) => s + parseFloat(e.amount), 0);
    const creditExps = monthExps.filter(e => e.payment_method === 'credit').reduce((s, e) => s + parseFloat(e.amount), 0);
    const debitExps = monthExps.filter(e => e.payment_method !== 'credit').reduce((s, e) => s + parseFloat(e.amount), 0);
    const available = userBalance - debitExps;

    document.getElementById('dashBalance').textContent = formatCurrency(userBalance);
    document.getElementById('dashTotalExpenses').textContent = formatCurrency(totalExpenses);
    document.getElementById('dashAvailable').textContent = formatCurrency(available);
    document.getElementById('dashSavings').textContent = formatCurrency(userSavings);
    document.getElementById('dashCount').textContent = monthExps.length;
    document.getElementById('expBalance').textContent = formatCurrency(userBalance);
    document.getElementById('dashCreditBill').textContent = formatCurrency(creditCardBill + creditExps);

    if (isAdmin()) {
        document.getElementById('marcosBalance').textContent = formatCurrency(adminBalances.marcos);
        document.getElementById('camilaBalance').textContent = formatCurrency(adminBalances.camila);
        document.getElementById('totalAdminBalance').textContent = formatCurrency(adminBalances.marcos + adminBalances.camila);
    }

    updateFixedCostAlerts();
    const recent = expenses.slice(0, 5);
    const recentList = document.getElementById('recentExpensesList');
    if (recent.length === 0) {
        recentList.innerHTML = '<div class="empty-state" style="padding:1.5rem"><span class="material-icons-round">receipt</span><p>Nenhuma despesa ainda</p></div>';
    } else {
        recentList.innerHTML = recent.map(e => {
            const cat = getCategoryInfo(e.category);
            const pm = e.payment_method === 'credit' ? '💳' : '🏦';
            const paidBy = isAdmin() && e.paid_by ? (e.paid_by === 'marcos' ? ' 👨' : ' 👩') : '';
            return `<div class="expense-mini-item"><div class="expense-mini-left"><span class="expense-mini-cat">${cat.emoji}</span><div><span class="expense-mini-desc">${escapeHtml(e.description)}${paidBy}</span><span class="expense-mini-date">${formatDate(e.expense_date)} ${pm}</span></div></div><span class="expense-mini-amount">- ${formatCurrency(e.amount)}</span></div>`;
        }).join('');
    }
    updateDashCategoryChart(monthExps);
    updateQuickAITip(monthExps, totalExpenses);
    updateIndicators(monthExps, totalExpenses);
}

function updateFixedCostAlerts() {
    const alertsEl = document.getElementById('fixedCostAlerts');
    if (!alertsEl || fixedCosts.length === 0) { if (alertsEl) alertsEl.classList.add('hidden'); return; }
    const today = new Date();
    const dayOfMonth = today.getDate();
    const upcoming = fixedCosts.filter(fc => { const diff = fc.due_day - dayOfMonth; return diff >= 0 && diff <= 5; });
    if (upcoming.length === 0) { alertsEl.classList.add('hidden'); return; }
    alertsEl.classList.remove('hidden');
    alertsEl.innerHTML = upcoming.map(fc => {
        const cat = getCategoryInfo(fc.category);
        const daysLeft = fc.due_day - dayOfMonth;
        const urgency = daysLeft <= 2 ? 'alert-urgent' : 'alert-warning';
        return `<div class="fc-alert ${urgency}"><span class="material-icons-round">notifications_active</span><div><strong>${cat.emoji} ${escapeHtml(fc.description)}</strong><span>${formatCurrency(fc.amount)} - vence ${daysLeft === 0 ? 'HOJE' : 'em ' + daysLeft + ' dia' + (daysLeft > 1 ? 's' : '')} (dia ${fc.due_day})</span></div></div>`;
    }).join('');
}

function updateIndicators(monthExps, totalExpenses) {
    const el = document.getElementById('indicatorsGrid'); if (!el) return;
    const now = new Date(); const dayOfMonth = now.getDate();
    const dailyAvg = dayOfMonth > 0 ? totalExpenses / dayOfMonth : 0;
    const prevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const prevMonthStr = `${prevMonth.getFullYear()}-${String(prevMonth.getMonth() + 1).padStart(2, '0')}`;
    const prevTotal = expenses.filter(e => e.expense_date && e.expense_date.startsWith(prevMonthStr)).reduce((s, e) => s + parseFloat(e.amount), 0);
    let comparison = 0, compIcon = 'trending_flat', compClass = 'neutral';
    if (prevTotal > 0) { comparison = ((totalExpenses - prevTotal) / prevTotal) * 100; if (comparison > 0) { compIcon = 'trending_up'; compClass = 'negative'; } else if (comparison < 0) { compIcon = 'trending_down'; compClass = 'positive'; } }
    const dayTotals = {}; monthExps.forEach(e => { dayTotals[e.expense_date] = (dayTotals[e.expense_date] || 0) + parseFloat(e.amount); });
    const busiestDay = Object.entries(dayTotals).sort((a, b) => b[1] - a[1])[0];
    const catCounts = {}; monthExps.forEach(e => { catCounts[e.category] = (catCounts[e.category] || 0) + 1; });
    const topFreqCat = Object.entries(catCounts).sort((a, b) => b[1] - a[1])[0];
    const freqCatInfo = topFreqCat ? getCategoryInfo(topFreqCat[0]) : null;
    el.innerHTML = `<div class="indicator-card"><div class="indicator-icon" style="background:linear-gradient(135deg,#667eea,#764ba2)"><span class="material-icons-round">speed</span></div><div class="indicator-info"><span class="indicator-label">Média Diária</span><span class="indicator-value">${formatCurrency(dailyAvg)}</span><span class="indicator-sub">${dayOfMonth} dias</span></div></div><div class="indicator-card"><div class="indicator-icon" style="background:linear-gradient(135deg,${compClass === 'positive' ? '#4ecdc4,#44bd9e' : compClass === 'negative' ? '#ff6b6b,#ee5a24' : '#ffd93d,#f0b429'})"><span class="material-icons-round">${compIcon}</span></div><div class="indicator-info"><span class="indicator-label">vs. Mês Anterior</span><span class="indicator-value ${compClass}">${comparison > 0 ? '+' : ''}${comparison.toFixed(1)}%</span><span class="indicator-sub">Anterior: ${formatCurrency(prevTotal)}</span></div></div><div class="indicator-card"><div class="indicator-icon" style="background:linear-gradient(135deg,#f093fb,#f5576c)"><span class="material-icons-round">event</span></div><div class="indicator-info"><span class="indicator-label">Dia Mais Caro</span><span class="indicator-value">${busiestDay ? formatDate(busiestDay[0]) : '-'}</span><span class="indicator-sub">${busiestDay ? formatCurrency(busiestDay[1]) : 'R$ 0,00'}</span></div></div><div class="indicator-card"><div class="indicator-icon" style="background:linear-gradient(135deg,#74b9ff,#5c8ff4)"><span class="material-icons-round">repeat</span></div><div class="indicator-info"><span class="indicator-label">Mais Frequente</span><span class="indicator-value">${freqCatInfo ? freqCatInfo.emoji + ' ' + freqCatInfo.label : '-'}</span><span class="indicator-sub">${topFreqCat ? topFreqCat[1] + ' lanc.' : ''}</span></div></div>`;
}

function updateDashCategoryChart(monthExps) {
    const ct = {}; monthExps.forEach(e => { ct[e.category] = (ct[e.category] || 0) + parseFloat(e.amount); });
    if (dashCategoryChartInstance) dashCategoryChartInstance.destroy();
    const ctx = document.getElementById('dashCategoryChart').getContext('2d');
    dashCategoryChartInstance = new Chart(ctx, { type: 'doughnut', data: { labels: Object.keys(ct).map(k => getCategoryInfo(k).label), datasets: [{ data: Object.values(ct), backgroundColor: Object.keys(ct).map(k => getCategoryInfo(k).color), borderWidth: 2, borderColor: '#fff', hoverOffset: 8 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 15, usePointStyle: true, font: { family: 'Inter', size: 12 } } } }, cutout: '65%' } });
}

function updateQuickAITip(monthExps, totalExpenses) {
    const tipEl = document.getElementById('dashAiTip');
    if (monthExps.length === 0) { tipEl.innerHTML = '<p>Adicione despesas para dicas personalizadas!</p>'; return; }
    const tips = generateAITips(monthExps, totalExpenses);
    if (tips.length > 0) tipEl.innerHTML = `<p>${tips[0].text}</p>`;
}


// ===== EXPENSES TABLE =====
function renderExpensesTable() {
    const tbody = document.getElementById('expensesTableBody');
    const emptyState = document.getElementById('emptyExpenses');
    const filterCat = document.getElementById('filterCategory').value;
    const filterMonth = document.getElementById('filterMonth').value;
    const filterPay = document.getElementById('filterPayment').value;
    let filtered = [...expenses];
    if (filterCat) filtered = filtered.filter(e => e.category === filterCat);
    if (filterMonth) filtered = filtered.filter(e => e.expense_date && e.expense_date.startsWith(filterMonth));
    if (filterPay) filtered = filtered.filter(e => e.payment_method === filterPay);
    if (filtered.length === 0) { tbody.innerHTML = ''; emptyState.classList.remove('hidden'); document.getElementById('filteredTotal').textContent = formatCurrency(0); return; }
    emptyState.classList.add('hidden');
    const total = filtered.reduce((s, e) => s + parseFloat(e.amount), 0);
    document.getElementById('filteredTotal').textContent = formatCurrency(total);
    tbody.innerHTML = filtered.map(e => {
        const cat = getCategoryInfo(e.category);
        const paidByLabel = e.paid_by ? (e.paid_by === 'marcos' ? '👨 Marcos' : '👩 Camila') : (e.user_name ? (e.user_name === 'marcos' ? '👨 Marcos' : '👩 Camila') : '');
        const pmLabel = e.payment_method === 'credit' ? '💳 Cartão' : '🏦 Débito';
        return `<tr><td>${formatDate(e.expense_date)}</td><td><div>${escapeHtml(e.description)}</div>${isAdmin() ? `<small style="color:var(--text-muted);font-size:0.72rem">${paidByLabel}</small>` : ''}</td><td><span class="category-badge">${cat.emoji} ${cat.label}</span></td><td><span class="payment-badge ${e.payment_method === 'credit' ? 'payment-credit' : 'payment-debit'}">${pmLabel}</span></td><td class="expense-amount">- ${formatCurrency(e.amount)}</td><td><div class="action-btns"><button class="btn-action btn-action-edit" onclick="openEditExpense('${e.id}')" title="Editar"><span class="material-icons-round">edit</span></button><button class="btn-action btn-action-delete" onclick="openDeleteExpense('${e.id}')" title="Excluir"><span class="material-icons-round">delete</span></button></div></td></tr>`;
    }).join('');
}

document.getElementById('filterCategory').addEventListener('change', renderExpensesTable);
document.getElementById('filterMonth').addEventListener('change', renderExpensesTable);
document.getElementById('filterPayment').addEventListener('change', renderExpensesTable);
document.getElementById('btnClearFilters').addEventListener('click', () => { document.getElementById('filterCategory').value = ''; document.getElementById('filterMonth').value = ''; document.getElementById('filterPayment').value = ''; renderExpensesTable(); });

// ===== EXPENSE MODAL =====
const expenseModal = document.getElementById('expenseModal');
const expenseForm = document.getElementById('expenseForm');
document.getElementById('btnAddExpense').addEventListener('click', () => {
    document.getElementById('expenseModalTitle').textContent = 'Nova Despesa';
    expenseForm.reset(); document.getElementById('expenseId').value = '';
    document.getElementById('expDate').value = new Date().toISOString().split('T')[0];
    if (isAdmin()) { document.getElementById('paidByGroup').style.display = ''; document.getElementById('expPaidBy').value = currentUser.username; }
    expenseModal.classList.remove('hidden');
});
document.getElementById('btnCloseExpenseModal').addEventListener('click', () => expenseModal.classList.add('hidden'));
document.getElementById('btnCancelExpense').addEventListener('click', () => expenseModal.classList.add('hidden'));
expenseModal.addEventListener('click', (e) => { if (e.target === expenseModal) expenseModal.classList.add('hidden'); });

expenseForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('expenseId').value;
    const expense = {
        description: document.getElementById('expDescription').value.trim(),
        category: document.getElementById('expCategory').value,
        amount: parseFloat(document.getElementById('expAmount').value),
        expense_date: document.getElementById('expDate').value,
        payment_method: document.getElementById('expPaymentMethod').value,
        paid_by: isAdmin() ? document.getElementById('expPaidBy').value : currentUser.username
    };
    if (id) { expense.id = id; expense._isEdit = true; }
    if (expense.payment_method === 'credit' && !expense._isEdit) { creditCardBill += expense.amount; await saveCreditCard(); }
    await saveExpense(expense);
    expenseModal.classList.add('hidden'); renderExpensesTable(); updateDashboard();
    showToast(id ? 'Despesa atualizada!' : 'Despesa adicionada!', 'success');
});

window.openEditExpense = function (id) {
    const expense = expenses.find(e => e.id == id); if (!expense) return;
    document.getElementById('expenseModalTitle').textContent = 'Editar Despesa';
    document.getElementById('expenseId').value = expense.id;
    document.getElementById('expDescription').value = expense.description;
    document.getElementById('expCategory').value = expense.category;
    document.getElementById('expAmount').value = expense.amount;
    document.getElementById('expDate').value = expense.expense_date;
    document.getElementById('expPaymentMethod').value = expense.payment_method || 'debit';
    if (isAdmin()) document.getElementById('expPaidBy').value = expense.paid_by || expense.user_name || 'marcos';
    expenseModal.classList.remove('hidden');
};

const deleteModal = document.getElementById('deleteModal');
let deleteTargetId = null, deleteType = 'expense';
window.openDeleteExpense = function (id) {
    const expense = expenses.find(e => e.id == id); if (!expense) return;
    deleteTargetId = id; deleteType = 'expense';
    document.getElementById('deleteExpenseDesc').textContent = `${escapeHtml(expense.description)} - ${formatCurrency(expense.amount)}`;
    deleteModal.classList.remove('hidden');
};
window.openDeleteFixedCost = function (id) {
    const fc = fixedCosts.find(f => f.id == id); if (!fc) return;
    deleteTargetId = id; deleteType = 'fixedcost';
    document.getElementById('deleteExpenseDesc').textContent = `${escapeHtml(fc.description)} - ${formatCurrency(fc.amount)}/mês`;
    deleteModal.classList.remove('hidden');
};

document.getElementById('btnCloseDeleteModal').addEventListener('click', () => deleteModal.classList.add('hidden'));
document.getElementById('btnCancelDelete').addEventListener('click', () => deleteModal.classList.add('hidden'));
deleteModal.addEventListener('click', (e) => { if (e.target === deleteModal) deleteModal.classList.add('hidden'); });
document.getElementById('btnConfirmDelete').addEventListener('click', async () => {
    if (!deleteTargetId) return;
    if (deleteType === 'expense') { await deleteExpense(deleteTargetId); renderExpensesTable(); updateDashboard(); showToast('Despesa excluída!', 'success'); }
    else if (deleteType === 'fixedcost') { await deleteFixedCost(deleteTargetId); updateFixedCostsPanel(); showToast('Custo fixo removido!', 'success'); }
    deleteTargetId = null; deleteModal.classList.add('hidden');
});

// ===== BALANCE MODAL =====
const balanceModal = document.getElementById('balanceModal');
const balanceForm = document.getElementById('balanceForm');
function openBalanceModal() {
    document.getElementById('balanceModalTitle').textContent = 'Atualizar Saldo';
    document.getElementById('balanceAmountLabel').textContent = 'Saldo em Conta (R$)';
    document.getElementById('balanceTargetUser').value = '';
    document.getElementById('balanceAmount').value = userBalance || '';
    balanceModal.classList.remove('hidden');
}
window.openAdminBalanceModal = function (user) {
    document.getElementById('balanceModalTitle').textContent = 'Saldo de ' + (user === 'marcos' ? 'Marcos' : 'Camila');
    document.getElementById('balanceAmountLabel').textContent = 'Saldo de ' + (user === 'marcos' ? 'Marcos' : 'Camila') + ' (R$)';
    document.getElementById('balanceTargetUser').value = user;
    document.getElementById('balanceAmount').value = adminBalances[user] || '';
    balanceModal.classList.remove('hidden');
};
document.getElementById('btnEditBalance').addEventListener('click', openBalanceModal);
document.getElementById('btnUpdateBalance').addEventListener('click', openBalanceModal);
document.getElementById('btnCloseBalanceModal').addEventListener('click', () => balanceModal.classList.add('hidden'));
document.getElementById('btnCancelBalance').addEventListener('click', () => balanceModal.classList.add('hidden'));
balanceModal.addEventListener('click', (e) => { if (e.target === balanceModal) balanceModal.classList.add('hidden'); });
balanceForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('balanceAmount').value);
    const targetUser = document.getElementById('balanceTargetUser').value;
    await saveBalance(amount, targetUser || undefined);
    balanceModal.classList.add('hidden'); updateDashboard(); showToast('Saldo atualizado!', 'success');
});

// ===== FIXED COSTS PANEL =====
function updateFixedCostsPanel() {
    const totalMonth = fixedCosts.reduce((s, fc) => s + parseFloat(fc.amount), 0);
    document.getElementById('fcTotalMonth').textContent = formatCurrency(totalMonth);
    const today = new Date().getDate();
    const upcoming = fixedCosts.filter(fc => { const d = fc.due_day - today; return d >= 0 && d <= 5; }).length;
    document.getElementById('fcUpcoming').textContent = upcoming;
    const listEl = document.getElementById('fixedCostsList');
    if (fixedCosts.length === 0) { listEl.innerHTML = '<div class="empty-state"><span class="material-icons-round">event_repeat</span><p>Nenhum custo fixo</p><small>Clique em "Novo Custo Fixo"</small></div>'; return; }
    listEl.innerHTML = fixedCosts.map(fc => {
        const cat = getCategoryInfo(fc.category); const td = new Date().getDate();
        const diff = fc.due_day - td; let statusClass = 'fc-ok', statusText = 'Vence dia ' + fc.due_day;
        if (diff < 0) statusText = 'Vencido este mês';
        else if (diff === 0) { statusClass = 'fc-today'; statusText = 'Vence HOJE!'; }
        else if (diff <= 3) { statusClass = 'fc-urgent'; statusText = 'Vence em ' + diff + ' dia' + (diff > 1 ? 's' : ''); }
        else if (diff <= 5) { statusClass = 'fc-soon'; statusText = 'Vence em ' + diff + ' dias'; }
        return `<div class="fc-card glass-card ${statusClass}"><div class="fc-card-left"><span class="fc-emoji">${cat.emoji}</span><div><strong>${escapeHtml(fc.description)}</strong><span class="fc-cat">${cat.label}</span></div></div><div class="fc-card-right"><span class="fc-amount">${formatCurrency(fc.amount)}</span><span class="fc-due">${statusText}</span><div class="action-btns"><button class="btn-action btn-action-edit" onclick="openEditFixedCost('${fc.id}')" title="Editar"><span class="material-icons-round">edit</span></button><button class="btn-action btn-action-delete" onclick="openDeleteFixedCost('${fc.id}')" title="Excluir"><span class="material-icons-round">delete</span></button></div></div></div>`;
    }).join('');
}

const fixedCostModal = document.getElementById('fixedCostModal');
const fixedCostForm = document.getElementById('fixedCostForm');
document.getElementById('btnAddFixedCost').addEventListener('click', () => {
    document.getElementById('fixedCostModalTitle').textContent = 'Novo Custo Fixo';
    fixedCostForm.reset(); document.getElementById('fixedCostId').value = '';
    fixedCostModal.classList.remove('hidden');
});
document.getElementById('btnCloseFixedCostModal').addEventListener('click', () => fixedCostModal.classList.add('hidden'));
document.getElementById('btnCancelFixedCost').addEventListener('click', () => fixedCostModal.classList.add('hidden'));
fixedCostModal.addEventListener('click', (e) => { if (e.target === fixedCostModal) fixedCostModal.classList.add('hidden'); });
fixedCostForm.addEventListener('submit', async (e) => {
    e.preventDefault(); const id = document.getElementById('fixedCostId').value;
    const fc = { description: document.getElementById('fcDescription').value.trim(), category: document.getElementById('fcCategory').value, amount: parseFloat(document.getElementById('fcAmount').value), due_day: parseInt(document.getElementById('fcDueDay').value) };
    if (id) { fc.id = id; fc._isEdit = true; }
    await saveFixedCost(fc); fixedCostModal.classList.add('hidden'); updateFixedCostsPanel(); updateDashboard();
    showToast(id ? 'Custo fixo atualizado!' : 'Custo fixo adicionado!', 'success');
});
window.openEditFixedCost = function (id) {
    const fc = fixedCosts.find(f => f.id == id); if (!fc) return;
    document.getElementById('fixedCostModalTitle').textContent = 'Editar Custo Fixo';
    document.getElementById('fixedCostId').value = fc.id; document.getElementById('fcDescription').value = fc.description;
    document.getElementById('fcCategory').value = fc.category; document.getElementById('fcAmount').value = fc.amount;
    document.getElementById('fcDueDay').value = fc.due_day; fixedCostModal.classList.remove('hidden');
};

// ===== CREDIT CARD PANEL =====
function updateCreditCardPanel() {
    const creditExps = getMonthExpenses().filter(e => e.payment_method === 'credit').reduce((s, e) => s + parseFloat(e.amount), 0);
    const totalBill = creditCardBill + creditExps;
    const available = Math.max(0, creditCardLimit - totalBill);
    document.getElementById('ccLimitValue').textContent = formatCurrency(creditCardLimit);
    document.getElementById('ccBillValue').textContent = formatCurrency(totalBill);
    document.getElementById('ccAvailableValue').textContent = formatCurrency(available);
    const pct = creditCardLimit > 0 ? Math.min(100, (totalBill / creditCardLimit) * 100) : 0;
    document.getElementById('ccGaugePercent').textContent = pct.toFixed(0) + '%';
    updateCCGaugeChart(pct);
    const statusEl = document.getElementById('ccGaugeStatus');
    if (creditCardLimit <= 0) { statusEl.textContent = 'Configure seu cartão para ver o uso'; statusEl.className = 'cc-gauge-status'; }
    else if (pct >= 80) { statusEl.textContent = 'ATENÇÃO: Limite muito comprometido!'; statusEl.className = 'cc-gauge-status cc-status-danger'; }
    else if (pct >= 50) { statusEl.textContent = 'Cuidado: Mais da metade do limite usado'; statusEl.className = 'cc-gauge-status cc-status-warning'; }
    else { statusEl.textContent = 'Bom: Limite sob controle'; statusEl.className = 'cc-gauge-status cc-status-good'; }
    updateCCAiAnalysis(totalBill, pct);
    const ccExpsList = document.getElementById('ccExpensesList');
    const ccExps = getMonthExpenses().filter(e => e.payment_method === 'credit');
    if (ccExps.length === 0) { ccExpsList.innerHTML = '<div class="empty-state" style="padding:1rem"><p>Nenhuma despesa no cartão este mês</p></div>'; }
    else { ccExpsList.innerHTML = ccExps.map(e => { const cat = getCategoryInfo(e.category); return `<div class="expense-mini-item"><div class="expense-mini-left"><span class="expense-mini-cat">${cat.emoji}</span><div><span class="expense-mini-desc">${escapeHtml(e.description)}</span><span class="expense-mini-date">${formatDate(e.expense_date)}</span></div></div><span class="expense-mini-amount">- ${formatCurrency(e.amount)}</span></div>`; }).join(''); }
}

function updateCCGaugeChart(pct) {
    if (ccGaugeChartInstance) ccGaugeChartInstance.destroy();
    const ctx = document.getElementById('ccGaugeChart').getContext('2d');
    const color = pct >= 80 ? '#ff6b6b' : pct >= 50 ? '#ffd93d' : '#4ecdc4';
    ccGaugeChartInstance = new Chart(ctx, { type: 'doughnut', data: { datasets: [{ data: [pct, 100 - pct], backgroundColor: [color, 'rgba(200,200,200,0.15)'], borderWidth: 0, circumference: 270, rotation: 225 }] }, options: { responsive: true, maintainAspectRatio: false, cutout: '78%', plugins: { legend: { display: false }, tooltip: { enabled: false } } } });
}

function updateCCAiAnalysis(totalBill, pct) {
    const el = document.getElementById('ccAiAnalysis');
    if (creditCardLimit <= 0) { el.innerHTML = '<p>Configure o limite do cartão para análises.</p>'; return; }
    let msgs = [];
    msgs.push('Você está usando ' + pct.toFixed(0) + '% do limite de ' + formatCurrency(creditCardLimit) + '.');
    if (pct >= 80) msgs.push('<strong>Alerta crítico!</strong> Limite muito comprometido. Evite novas compras no crédito.');
    else if (pct >= 60) msgs.push('<strong>Atenção!</strong> Mais de 60% do limite usado. Revise compras parceladas.');
    else if (pct >= 40) msgs.push('Uso moderado do cartão. Continue controlando para não ultrapassar 50%.');
    else msgs.push('<strong>Ótimo!</strong> Uso saudável do cartão. Manter abaixo de 30% é ideal.');
    msgs.push('Disponível no cartão: ' + formatCurrency(Math.max(0, creditCardLimit - totalBill)));
    el.innerHTML = msgs.map(m => '<p style="margin-bottom:0.5rem">' + m + '</p>').join('');
}

const creditCardModal = document.getElementById('creditCardModal');
const creditCardForm = document.getElementById('creditCardForm');
document.getElementById('btnConfigCard').addEventListener('click', () => {
    document.getElementById('ccLimit').value = creditCardLimit || '';
    document.getElementById('ccBill').value = creditCardBill || '';
    creditCardModal.classList.remove('hidden');
});
document.getElementById('btnCloseCreditCardModal').addEventListener('click', () => creditCardModal.classList.add('hidden'));
document.getElementById('btnCancelCreditCard').addEventListener('click', () => creditCardModal.classList.add('hidden'));
creditCardModal.addEventListener('click', (e) => { if (e.target === creditCardModal) creditCardModal.classList.add('hidden'); });
creditCardForm.addEventListener('submit', async (e) => {
    e.preventDefault(); creditCardLimit = parseFloat(document.getElementById('ccLimit').value) || 0;
    creditCardBill = parseFloat(document.getElementById('ccBill').value) || 0;
    await saveCreditCard(); creditCardModal.classList.add('hidden'); updateCreditCardPanel(); updateDashboard();
    showToast('Cartão configurado!', 'success');
});



// ===== INCOME MODAL =====
const incomeModal = document.getElementById('incomeModal');
const incomeForm = document.getElementById('incomeForm');
document.getElementById('btnAddIncome').addEventListener('click', () => {
    incomeForm.reset();
    if (isAdmin() && currentUser.is_admin) {
        document.getElementById('incomeTargetGroup').style.display = '';
        document.getElementById('incomeTarget').value = currentUser.username;
    } else if (currentUser.shared_with) {
        document.getElementById('incomeTargetGroup').style.display = '';
    } else {
        document.getElementById('incomeTargetGroup').style.display = 'none';
    }
    incomeModal.classList.remove('hidden');
});
document.getElementById('btnCloseIncomeModal').addEventListener('click', () => incomeModal.classList.add('hidden'));
document.getElementById('btnCancelIncome').addEventListener('click', () => incomeModal.classList.add('hidden'));
incomeModal.addEventListener('click', (e) => { if (e.target === incomeModal) incomeModal.classList.add('hidden'); });
incomeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const amount = parseFloat(document.getElementById('incomeAmount').value);
    const description = document.getElementById('incomeDescription').value.trim();
    const target = (isAdmin() || currentUser.shared_with) ? document.getElementById('incomeTarget').value : currentUser.username;
    if (isAdmin() && currentUser.is_admin) {
        adminBalances[target] = (adminBalances[target] || 0) + amount;
        await saveBalance(adminBalances[target], target);
    } else if (currentUser.shared_with) {
        adminBalances[target] = (adminBalances[target] || 0) + amount;
        await saveBalance(adminBalances[target], target);
    } else {
        userBalance += amount;
        await saveBalance(userBalance);
    }
    incomeModal.classList.add('hidden');
    updateDashboard();
    showToast(escapeHtml(description) + ': +' + formatCurrency(amount) + ' adicionado!', 'success');
});

// ===== SAVINGS =====
function updateSavingsPanel() {
    document.getElementById('savingsAmount').textContent = formatCurrency(userSavings);
    document.getElementById('savingsGoal').textContent = formatCurrency(savingsGoal);
    const remaining = Math.max(0, savingsGoal - userSavings);
    document.getElementById('savingsRemaining').textContent = formatCurrency(remaining);
    const pct = savingsGoal > 0 ? Math.min(100, (userSavings / savingsGoal) * 100) : 0;
    document.getElementById('savingsPercent').textContent = pct.toFixed(1) + '%';
    document.getElementById('savingsProgressFill').style.width = pct + '%';
    if (savingsGoalDesc) document.getElementById('savingsGoalDesc').textContent = 'Meta: ' + savingsGoalDesc;
    else if (savingsGoal > 0) document.getElementById('savingsGoalDesc').textContent = 'Continue guardando para atingir sua meta!';
    else document.getElementById('savingsGoalDesc').textContent = 'Defina uma meta para acompanhar seu progresso!';
    updateSavingsAIRecommendation();
}
function updateSavingsAIRecommendation() {
    const el = document.getElementById('savingsAiRecommendation');
    const monthExps = getMonthExpenses(); const totalExpenses = monthExps.reduce((s, e) => s + parseFloat(e.amount), 0);
    const available = userBalance - totalExpenses;
    if (userBalance <= 0 && monthExps.length === 0) { el.innerHTML = '<p>Cadastre seu saldo e despesas para recomendações!</p>'; return; }
    let msgs = [];
    if (available > 0) {
        msgs.push('Disponível: ' + formatCurrency(available) + '. Conservador (20%): guarde ' + formatCurrency(available * 0.2) + '. Agressivo (30%): guarde ' + formatCurrency(available * 0.3) + '.');
        if (savingsGoal > 0) { const rem = Math.max(0, savingsGoal - userSavings); if (rem > 0) msgs.push('Faltam ' + formatCurrency(rem) + ' para a meta. ~' + Math.ceil(rem / (available * 0.2)) + ' meses (20%/mês).'); else msgs.push('Meta atingida! Defina uma nova meta.'); }
    } else if (available <= 0) { msgs.push('Despesas ultrapassaram o saldo. Revise gastos!'); }
    el.innerHTML = msgs.map(m => '<p style="margin-bottom:0.5rem">' + m + '</p>').join('') || '<p>Continue registrando para análises.</p>';
}
const savingsModal = document.getElementById('savingsModal'); const savingsForm = document.getElementById('savingsForm');
document.getElementById('btnAddSavings').addEventListener('click', () => {
    document.getElementById('savingsModalTitle').textContent = 'Depositar na Poupança';
    document.getElementById('savingsValueLabel').textContent = 'Valor a depositar (R$)';
    document.getElementById('savingsAction').value = 'deposit';
    document.getElementById('btnSavingsSubmit').querySelector('span:last-child').textContent = 'Depositar';
    savingsForm.reset(); document.getElementById('savingsAction').value = 'deposit'; savingsModal.classList.remove('hidden');
});
document.getElementById('btnWithdrawSavings').addEventListener('click', () => {
    document.getElementById('savingsModalTitle').textContent = 'Retirar da Poupança';
    document.getElementById('savingsValueLabel').textContent = 'Valor a retirar (R$)';
    document.getElementById('savingsAction').value = 'withdraw';
    document.getElementById('btnSavingsSubmit').querySelector('span:last-child').textContent = 'Retirar';
    savingsForm.reset(); document.getElementById('savingsAction').value = 'withdraw'; savingsModal.classList.remove('hidden');
});
document.getElementById('btnCloseSavingsModal').addEventListener('click', () => savingsModal.classList.add('hidden'));
document.getElementById('btnCancelSavings').addEventListener('click', () => savingsModal.classList.add('hidden'));
savingsModal.addEventListener('click', (e) => { if (e.target === savingsModal) savingsModal.classList.add('hidden'); });
savingsForm.addEventListener('submit', async (e) => {
    e.preventDefault(); const action = document.getElementById('savingsAction').value;
    const value = parseFloat(document.getElementById('savingsValue').value);
    if (action === 'deposit') { userSavings += value; showToast(formatCurrency(value) + ' depositado!', 'success'); }
    else { if (value > userSavings) { showToast('Valor maior que o saldo!', 'error'); return; } userSavings -= value; showToast(formatCurrency(value) + ' retirado!', 'success'); }
    await saveSavingsData(); savingsModal.classList.add('hidden'); updateSavingsPanel(); updateDashboard();
});
const goalModal = document.getElementById('goalModal'); const goalForm = document.getElementById('goalForm');
document.getElementById('btnSetGoal').addEventListener('click', () => { document.getElementById('goalAmount').value = savingsGoal || ''; document.getElementById('goalDescription').value = savingsGoalDesc || ''; goalModal.classList.remove('hidden'); });
document.getElementById('btnCloseGoalModal').addEventListener('click', () => goalModal.classList.add('hidden'));
document.getElementById('btnCancelGoal').addEventListener('click', () => goalModal.classList.add('hidden'));
goalModal.addEventListener('click', (e) => { if (e.target === goalModal) goalModal.classList.add('hidden'); });
goalForm.addEventListener('submit', async (e) => { e.preventDefault(); savingsGoal = parseFloat(document.getElementById('goalAmount').value) || 0; savingsGoalDesc = document.getElementById('goalDescription').value.trim(); await saveSavingsData(); goalModal.classList.add('hidden'); updateSavingsPanel(); showToast('Meta definida!', 'success'); });

// ===== EVOLUTION =====
function updateEvolution() { updateMonthlyChart(); updateEvoCategoryChart(); updateDailyChart(); updateEvoStats(); }
function updateMonthlyChart() {
    const now = new Date(); const months = [], totals = [];
    for (let i = 5; i >= 0; i--) { const d = new Date(now.getFullYear(), now.getMonth() - i, 1); const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'); months.push(d.toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' })); totals.push(expenses.filter(e => e.expense_date && e.expense_date.startsWith(key)).reduce((s, e) => s + parseFloat(e.amount), 0)); }
    if (evoMonthlyChartInstance) evoMonthlyChartInstance.destroy();
    const ctx = document.getElementById('evoMonthlyChart').getContext('2d'); const g = ctx.createLinearGradient(0, 0, 0, 280); g.addColorStop(0, 'rgba(102,126,234,0.3)'); g.addColorStop(1, 'rgba(102,126,234,0.02)');
    evoMonthlyChartInstance = new Chart(ctx, { type: 'bar', data: { labels: months, datasets: [{ label: 'Total', data: totals, backgroundColor: g, borderColor: '#667eea', borderWidth: 2, borderRadius: 8, borderSkipped: false }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + formatCurrency(c.raw) } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => formatCurrency(v), font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(0,0,0,0.04)' } }, x: { ticks: { font: { family: 'Inter', size: 11 } }, grid: { display: false } } } } });
}
function updateEvoCategoryChart() {
    const ct = {}; expenses.forEach(e => { ct[e.category] = (ct[e.category] || 0) + parseFloat(e.amount); });
    if (evoCategoryChartInstance) evoCategoryChartInstance.destroy();
    const ctx = document.getElementById('evoCategoryChart').getContext('2d');
    evoCategoryChartInstance = new Chart(ctx, { type: 'polarArea', data: { labels: Object.keys(ct).map(k => getCategoryInfo(k).label), datasets: [{ data: Object.values(ct), backgroundColor: Object.keys(ct).map(k => getCategoryInfo(k).color + '80'), borderColor: Object.keys(ct).map(k => getCategoryInfo(k).color), borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { padding: 12, usePointStyle: true, font: { family: 'Inter', size: 11 } } } } } });
}
function updateDailyChart() {
    const ms = getCurrentMonthStr(); const me = expenses.filter(e => e.expense_date && e.expense_date.startsWith(ms));
    const dt = {}; me.forEach(e => { dt[e.expense_date] = (dt[e.expense_date] || 0) + parseFloat(e.amount); });
    const sd = Object.keys(dt).sort(); let cum = 0; const cd = sd.map(d => { cum += dt[d]; return cum; });
    if (evoDailyChartInstance) evoDailyChartInstance.destroy();
    const ctx = document.getElementById('evoDailyChart').getContext('2d'); const g = ctx.createLinearGradient(0, 0, 0, 200); g.addColorStop(0, 'rgba(240,147,251,0.2)'); g.addColorStop(1, 'rgba(240,147,251,0.01)');
    evoDailyChartInstance = new Chart(ctx, { type: 'line', data: { labels: sd.map(d => { const p = d.split('-'); return p[2] + '/' + p[1]; }), datasets: [{ label: 'Diário', data: sd.map(d => dt[d]), borderColor: '#667eea', backgroundColor: 'rgba(102,126,234,0.1)', borderWidth: 2, pointRadius: 4, tension: 0.4 }, { label: 'Acumulado', data: cd, borderColor: '#f093fb', backgroundColor: g, borderWidth: 2, pointRadius: 3, tension: 0.4, fill: true }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { usePointStyle: true, font: { family: 'Inter', size: 12 } } }, tooltip: { callbacks: { label: c => ' ' + c.dataset.label + ': ' + formatCurrency(c.raw) } } }, scales: { y: { beginAtZero: true, ticks: { callback: v => formatCurrency(v), font: { family: 'Inter', size: 11 } }, grid: { color: 'rgba(0,0,0,0.04)' } }, x: { ticks: { font: { family: 'Inter', size: 11 } }, grid: { display: false } } } } });
}
function updateEvoStats() {
    if (expenses.length === 0) { document.getElementById('evoHighest').textContent = 'R$ 0,00'; document.getElementById('evoAverage').textContent = 'R$ 0,00'; document.getElementById('evoTopCategory').textContent = '-'; return; }
    const highest = Math.max(...expenses.map(e => parseFloat(e.amount))); const total = expenses.reduce((s, e) => s + parseFloat(e.amount), 0);
    const ct = {}; expenses.forEach(e => { ct[e.category] = (ct[e.category] || 0) + parseFloat(e.amount); }); const tc = Object.entries(ct).sort((a, b) => b[1] - a[1])[0];
    document.getElementById('evoHighest').textContent = formatCurrency(highest); document.getElementById('evoAverage').textContent = formatCurrency(total / expenses.length); document.getElementById('evoTopCategory').textContent = tc ? getCategoryInfo(tc[0]).label : '-';
}

// ===== AI ASSISTANT =====
function generateAITips(monthExps, totalExpenses) {
    const tips = []; const ct = {}; monthExps.forEach(e => { ct[e.category] = (ct[e.category] || 0) + parseFloat(e.amount); });
    const sc = Object.entries(ct).sort((a, b) => b[1] - a[1]);
    if (sc.length > 0) {
        const topCat = sc[0][0]; const topAmt = sc[0][1]; const ci = getCategoryInfo(topCat); const pct = ((topAmt / totalExpenses) * 100).toFixed(0);
        if (pct > 50) tips.push({ type: 'warning', icon: 'warning', title: ci.emoji + ' ' + ci.label + ' domina seus gastos', text: pct + '% em ' + ci.label + ' (' + formatCurrency(topAmt) + '). Defina um limite mensal.' });
        else tips.push({ type: 'info', icon: 'info', title: ci.emoji + ' Maior: ' + ci.label, text: ci.label + ' com ' + formatCurrency(topAmt) + ' (' + pct + '%).' });
    }
    if (userBalance > 0) { const ratio = totalExpenses / userBalance; if (ratio > 0.8) tips.push({ type: 'danger', icon: 'danger', title: 'Saldo crítico!', text: (ratio * 100).toFixed(0) + '% do saldo gasto.' }); else if (ratio > 0.5) tips.push({ type: 'warning', icon: 'warning', title: 'Metade do saldo usado', text: (ratio * 100).toFixed(0) + '% utilizado.' }); else tips.push({ type: 'success', icon: 'success', title: 'Bom controle!', text: 'Apenas ' + (ratio * 100).toFixed(0) + '% usado. Continue assim!' }); }
    if (fixedCosts.length > 0) {
        const today = new Date().getDate(); const upcoming = fixedCosts.filter(fc => { const d = fc.due_day - today; return d >= 0 && d <= 5; });
        if (upcoming.length > 0) tips.push({ type: 'warning', icon: 'warning', title: upcoming.length + ' custo(s) fixo(s) próximo(s)', text: 'Lembre-se: ' + upcoming.map(fc => fc.description + ' (dia ' + fc.due_day + ')').join(', ') });
    }
    if (creditCardLimit > 0) {
        const ccPct = (creditCardBill / creditCardLimit) * 100;
        if (ccPct >= 70) tips.push({ type: 'danger', icon: 'danger', title: 'Limite do cartão alto', text: ccPct.toFixed(0) + '% do limite usado. Evite novas compras no crédito.' });
        else if (ccPct >= 40) tips.push({ type: 'info', icon: 'info', title: 'Cartão sob controle', text: ccPct.toFixed(0) + '% do limite usado. Continue monitorando.' });
    }
    if (savingsGoal > 0) { const rem = Math.max(0, savingsGoal - userSavings); if (rem > 0) { const avail = userBalance - totalExpenses; const sug = avail > 0 ? avail * 0.2 : 0; tips.push({ type: 'savings', icon: 'savings', title: 'Meta: ' + formatCurrency(savingsGoal), text: 'Faltam ' + formatCurrency(rem) + '. Guarde ' + formatCurrency(sug) + '/mês.' }); } else tips.push({ type: 'success', icon: 'success', title: 'Meta atingida!', text: 'Parabéns! Defina nova meta.' }); }
    if (monthExps.length < 3) tips.push({ type: 'info', icon: 'info', title: 'Continue registrando!', text: 'Registre todos os gastos para análise completa.' });
    return tips;
}
function updateAIAssistant() {
    const monthExps = getMonthExpenses(); const totalExpenses = monthExps.reduce((s, e) => s + parseFloat(e.amount), 0);
    const tips = generateAITips(monthExps, totalExpenses);
    let score = 50;
    if (userBalance > 0) { const r = totalExpenses / userBalance; if (r <= 0.3) score += 25; else if (r <= 0.5) score += 15; else if (r <= 0.7) score += 5; else if (r <= 0.9) score -= 10; else score -= 25; }
    if (expenses.length >= 5) score += 5; if (expenses.length >= 15) score += 5;
    if (userSavings > 0) score += 10; if (savingsGoal > 0 && userSavings >= savingsGoal) score += 10; else if (savingsGoal > 0 && userSavings >= savingsGoal * 0.5) score += 5;
    if (creditCardLimit > 0 && creditCardBill / creditCardLimit < 0.3) score += 5;
    score = Math.max(0, Math.min(100, score));
    const circle = document.getElementById('aiScoreCircle'); const circumference = 2 * Math.PI * 52;
    setTimeout(() => { circle.style.strokeDashoffset = circumference - (score / 100) * circumference; }, 200);
    document.getElementById('aiScoreValue').textContent = score;
    let desc = ''; if (score >= 80) desc = 'Excelente! Finanças bem controladas.'; else if (score >= 60) desc = 'Bom! Há espaço para melhorias.'; else if (score >= 40) desc = 'Atenção! Gastos podem estar altos.'; else desc = 'Alerta! Reveja gastos urgentemente.';
    document.getElementById('aiScoreDesc').textContent = desc;
    circle.style.stroke = score >= 70 ? '#4ecdc4' : score >= 40 ? '#ffd93d' : '#ff6b6b';
    const tipsGrid = document.getElementById('aiTipsGrid');
    if (tips.length === 0) { tipsGrid.innerHTML = '<div class="ai-tip-card"><p class="tip-text">Registre despesas para dicas.</p></div>'; }
    else {
        const im = { save: 'savings', warning: 'warning_amber', info: 'info', success: 'check_circle', danger: 'error', savings: 'savings' };
        tipsGrid.innerHTML = tips.map(t => '<div class="ai-tip-card"><div class="tip-icon tip-icon-' + t.icon + '"><span class="material-icons-round">' + (im[t.icon] || 'lightbulb') + '</span></div><div><div class="tip-title">' + t.title + '</div><div class="tip-text">' + t.text + '</div></div></div>').join('');
    }
    const chatEl = document.getElementById('aiChatMessages'); const msgs = [];
    msgs.push('Olá ' + currentUser.displayName + '! Analisei suas finanças.');
    if (monthExps.length === 0) msgs.push('Sem despesas este mês. Comece a registrar!');
    else {
        msgs.push(monthExps.length + ' despesas: ' + formatCurrency(totalExpenses) + '.');
        if (userBalance > 0) { const avail = userBalance - totalExpenses; msgs.push('Saldo: ' + formatCurrency(userBalance) + ' | Disponível: ' + formatCurrency(avail)); if (avail > 0) msgs.push('Guarde ' + formatCurrency(avail * 0.2) + ' (20%) na poupança!'); }
        if (fixedCosts.length > 0) { const fcTotal = fixedCosts.reduce((s, f) => s + parseFloat(f.amount), 0); msgs.push('Custos fixos: ' + formatCurrency(fcTotal) + '/mês (' + fixedCosts.length + ' iten' + (fixedCosts.length > 1 ? 's' : '') + ').'); }
        if (creditCardLimit > 0) { const pct = ((creditCardBill / creditCardLimit) * 100).toFixed(0); msgs.push('Cartão: ' + pct + '% do limite usado (' + formatCurrency(creditCardBill) + ' de ' + formatCurrency(creditCardLimit) + ')'); }
    }
    chatEl.innerHTML = msgs.map(m => '<div class="ai-message"><span class="material-icons-round">psychology</span><p>' + m + '</p></div>').join('');
}
document.getElementById('btnRefreshAI').addEventListener('click', () => { updateAIAssistant(); showToast('Análise atualizada!', 'info'); });

// ===== ADMIN USERS PANEL =====
function updateAdminUsersPanel() {
    if (!isMainAdmin()) return;
    const listEl = document.getElementById('pendingUsersList');
    if (!listEl) return;
    document.getElementById('pendingCount').textContent = pendingUsers.length;
    if (pendingUsers.length === 0) {
        listEl.innerHTML = '<div class="empty-state" style="padding:2rem"><span class="material-icons-round">verified_user</span><p>Nenhum usuário pendente</p><small>Todos os registros foram processados</small></div>';
        return;
    }
    listEl.innerHTML = pendingUsers.map(u => {
        const date = u.created_at ? new Date(u.created_at).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'Data desconhecida';
        return '<div class="pending-user-card glass-card"><div class="pending-user-info"><div class="pending-user-avatar"><span class="material-icons-round">person</span></div><div><strong>' + u.display_name + '</strong><span class="pending-user-detail">@' + u.username + '</span><span class="pending-user-detail">' + u.email + '</span><span class="pending-user-detail">Registrado: ' + date + '</span></div></div><div class="pending-user-actions"><button class="btn-approve" onclick="handleApproveUser(\'' + u.username + '\')"><span class="material-icons-round">check_circle</span><span>Aprovar</span></button><button class="btn-reject" onclick="handleRejectUser(\'' + u.username + '\')"><span class="material-icons-round">cancel</span><span>Rejeitar</span></button></div></div>';
    }).join('');
}

window.handleApproveUser = async function (username) {
    await approveUser(username);
    updateAdminUsersPanel();
    showToast('Usuário ' + username + ' aprovado!', 'success');
};
window.handleRejectUser = async function (username) {
    if (!confirm('Tem certeza que deseja rejeitar e excluir o registro de ' + username + '?')) return;
    await rejectUser(username);
    updateAdminUsersPanel();
    showToast('Registro de ' + username + ' rejeitado.', 'info');
};

// ===== TOAST =====
function showToast(message, type) {
    type = type || 'success';
    const toast = document.getElementById('toast'); const icons = { success: 'check_circle', error: 'error', info: 'info' };
    document.getElementById('toastIcon').textContent = icons[type] || 'info';
    toast.className = 'toast toast-' + type; document.getElementById('toastMessage').textContent = message;
    setTimeout(() => { toast.classList.add('hidden'); }, 3000);
}

// ===== INITIAL STATE =====
document.getElementById('headerDate').textContent = new Date().toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
