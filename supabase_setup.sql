-- ============================================
-- GESTÃO BE E MILA - Supabase Database Setup
-- SEGURANÇA REFORÇADA v2.1
-- Execute no Supabase SQL Editor
-- ============================================

-- Users table
CREATE TABLE IF NOT EXISTS users (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL,
    is_admin BOOLEAN DEFAULT false,
    is_approved BOOLEAN DEFAULT false,
    shared_with TEXT DEFAULT '',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed admin users (senhas com hash SHA-256)
INSERT INTO users (username, email, password_hash, display_name, is_admin, is_approved) VALUES
    ('marcos', 'marcos@bemila.com', '9de7bbbc25d7000a7441d12f25272de69bfa4bb4c531ade3cca82836d5feb03f', 'Marcos', true, true),
    ('camila', 'camila@bemila.com', '9260ec80f980fe198502eb7892aa860bf166c923b476926ce5e9ca5babdfd0d1', 'Camila', true, true)
ON CONFLICT (username) DO UPDATE SET
    password_hash = EXCLUDED.password_hash,
    is_admin = true,
    is_approved = true;

-- Expenses table
CREATE TABLE IF NOT EXISTS expenses (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    expense_date DATE NOT NULL,
    payment_method TEXT DEFAULT 'debit',
    paid_by TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Balances table
CREATE TABLE IF NOT EXISTS balances (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_name TEXT NOT NULL UNIQUE,
    amount DECIMAL(10,2) DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Savings table
CREATE TABLE IF NOT EXISTS savings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_name TEXT NOT NULL UNIQUE,
    amount DECIMAL(10,2) DEFAULT 0,
    goal_amount DECIMAL(10,2) DEFAULT 0,
    goal_description TEXT DEFAULT '',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fixed costs table
CREATE TABLE IF NOT EXISTS fixed_costs (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_name TEXT NOT NULL,
    description TEXT NOT NULL,
    category TEXT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    due_day INTEGER NOT NULL CHECK (due_day BETWEEN 1 AND 31),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Credit cards table
CREATE TABLE IF NOT EXISTS credit_cards (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_name TEXT NOT NULL UNIQUE,
    card_limit DECIMAL(10,2) DEFAULT 0,
    current_bill DECIMAL(10,2) DEFAULT 0,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- ============================================
-- ENABLE ROW LEVEL SECURITY
-- ============================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_cards ENABLE ROW LEVEL SECURITY;

-- ============================================
-- DROP OLD INSECURE POLICIES
-- ============================================
DROP POLICY IF EXISTS "Allow all for users" ON users;
DROP POLICY IF EXISTS "Allow all for expenses" ON expenses;
DROP POLICY IF EXISTS "Allow all for balances" ON balances;
DROP POLICY IF EXISTS "Allow all for savings" ON savings;
DROP POLICY IF EXISTS "Allow all for fixed_costs" ON fixed_costs;
DROP POLICY IF EXISTS "Allow all for credit_cards" ON credit_cards;

-- Drop new policies if re-running
DROP POLICY IF EXISTS "users_no_direct_read" ON users;
DROP POLICY IF EXISTS "users_insert_register" ON users;
DROP POLICY IF EXISTS "users_update_admin" ON users;
DROP POLICY IF EXISTS "users_delete_admin" ON users;
DROP POLICY IF EXISTS "expenses_all" ON expenses;
DROP POLICY IF EXISTS "balances_all" ON balances;
DROP POLICY IF EXISTS "savings_all" ON savings;
DROP POLICY IF EXISTS "fixed_costs_all" ON fixed_costs;
DROP POLICY IF EXISTS "credit_cards_all" ON credit_cards;

-- ============================================
-- SECURE RLS POLICIES
-- ============================================

-- USERS: Bloquear leitura direta (usar RPC para autenticar)
-- Ninguém pode fazer SELECT direto na tabela users pela anon key
CREATE POLICY "users_no_direct_read" ON users
    FOR SELECT USING (false);

-- Permitir INSERT para registro de novos usuários
CREATE POLICY "users_insert_register" ON users
    FOR INSERT WITH CHECK (is_admin = false AND is_approved = false);

-- Permitir UPDATE apenas via RPC (policy nega diretamente)
CREATE POLICY "users_update_admin" ON users
    FOR UPDATE USING (false);

-- Permitir DELETE apenas via RPC
CREATE POLICY "users_delete_admin" ON users
    FOR DELETE USING (false);

-- Demais tabelas: permitir acesso (dados não sensíveis)
CREATE POLICY "expenses_all" ON expenses
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "balances_all" ON balances
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "savings_all" ON savings
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "fixed_costs_all" ON fixed_costs
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "credit_cards_all" ON credit_cards
    FOR ALL USING (true) WITH CHECK (true);

-- ============================================
-- SECURE RPC FUNCTIONS (executam com SECURITY DEFINER)
-- Essas funções rodam com permissões do owner, 
-- ignorando RLS, para autenticar sem expor dados
-- ============================================

-- Função de autenticação: recebe username e hash, retorna dados SEM senha
CREATE OR REPLACE FUNCTION authenticate_user(p_username TEXT, p_password_hash TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    user_record RECORD;
BEGIN
    SELECT username, display_name, email, is_admin, is_approved, shared_with
    INTO user_record
    FROM users
    WHERE username = p_username AND password_hash = p_password_hash;

    IF NOT FOUND THEN
        RETURN json_build_object('success', false, 'error', 'invalid_credentials');
    END IF;

    IF NOT user_record.is_approved AND NOT user_record.is_admin THEN
        RETURN json_build_object('success', false, 'error', 'pending_approval');
    END IF;

    RETURN json_build_object(
        'success', true,
        'username', user_record.username,
        'displayName', user_record.display_name,
        'email', user_record.email,
        'is_admin', user_record.is_admin,
        'is_approved', user_record.is_approved,
        'shared_with', COALESCE(user_record.shared_with, '')
    );
END;
$$;

-- Função para registrar usuário (hash vem do cliente)
CREATE OR REPLACE FUNCTION register_user(p_username TEXT, p_email TEXT, p_password_hash TEXT, p_display_name TEXT, p_shared_with TEXT DEFAULT '')
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    existing_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO existing_count FROM users
    WHERE username = p_username OR email = p_email;

    IF existing_count > 0 THEN
        RETURN json_build_object('success', false, 'error', 'user_exists');
    END IF;

    INSERT INTO users (username, email, password_hash, display_name, is_admin, is_approved, shared_with)
    VALUES (p_username, p_email, p_password_hash, p_display_name, false, false, COALESCE(p_shared_with, ''));

    RETURN json_build_object('success', true);
END;
$$;

-- Função para listar usuários pendentes (apenas admin)
CREATE OR REPLACE FUNCTION get_pending_users(p_admin_username TEXT, p_admin_hash TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    is_admin_user BOOLEAN;
    pending JSON;
BEGIN
    SELECT is_admin INTO is_admin_user FROM users
    WHERE username = p_admin_username AND password_hash = p_admin_hash;

    IF NOT FOUND OR NOT is_admin_user THEN
        RETURN json_build_object('success', false, 'error', 'unauthorized');
    END IF;

    SELECT json_agg(json_build_object(
        'username', username,
        'display_name', display_name,
        'email', email,
        'created_at', created_at
    )) INTO pending
    FROM users WHERE is_approved = false AND is_admin = false;

    RETURN json_build_object('success', true, 'users', COALESCE(pending, '[]'::json));
END;
$$;

-- Função para aprovar usuário (apenas admin)
CREATE OR REPLACE FUNCTION approve_user(p_admin_username TEXT, p_admin_hash TEXT, p_target_username TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    is_admin_user BOOLEAN;
BEGIN
    SELECT is_admin INTO is_admin_user FROM users
    WHERE username = p_admin_username AND password_hash = p_admin_hash;

    IF NOT FOUND OR NOT is_admin_user THEN
        RETURN json_build_object('success', false, 'error', 'unauthorized');
    END IF;

    UPDATE users SET is_approved = true WHERE username = p_target_username;
    RETURN json_build_object('success', true);
END;
$$;

-- Função para rejeitar/excluir usuário (apenas admin)
CREATE OR REPLACE FUNCTION reject_user(p_admin_username TEXT, p_admin_hash TEXT, p_target_username TEXT)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    is_admin_user BOOLEAN;
BEGIN
    SELECT is_admin INTO is_admin_user FROM users
    WHERE username = p_admin_username AND password_hash = p_admin_hash;

    IF NOT FOUND OR NOT is_admin_user THEN
        RETURN json_build_object('success', false, 'error', 'unauthorized');
    END IF;

    DELETE FROM users WHERE username = p_target_username AND is_approved = false AND is_admin = false;
    RETURN json_build_object('success', true);
END;
$$;

-- ============================================
-- INDEXES
-- ============================================
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_name);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_balances_user ON balances(user_name);
CREATE INDEX IF NOT EXISTS idx_savings_user ON savings(user_name);
CREATE INDEX IF NOT EXISTS idx_fixed_costs_user ON fixed_costs(user_name);
CREATE INDEX IF NOT EXISTS idx_credit_cards_user ON credit_cards(user_name);

-- Upgrade: add columns if missing
-- ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'debit';
-- ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_by TEXT;
-- ALTER TABLE users ADD COLUMN IF NOT EXISTS is_approved BOOLEAN DEFAULT false;
