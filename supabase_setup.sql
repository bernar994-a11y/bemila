-- ============================================
-- GESTÃO BE E MILA - Supabase Database Setup
-- Execute these SQL commands in the Supabase 
-- SQL Editor (Dashboard > SQL Editor)
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
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Seed admin users (marcos and camila)
INSERT INTO users (username, email, password_hash, display_name, is_admin, is_approved) VALUES
    ('marcos', 'marcos@bemila.com', '290902', 'Marcos', true, true),
    ('camila', 'camila@bemila.com', '080805', 'Camila', true, true)
ON CONFLICT (username) DO UPDATE SET is_admin = true, is_approved = true;

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

-- Savings table (poupança)
CREATE TABLE IF NOT EXISTS savings (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    user_name TEXT NOT NULL UNIQUE,
    amount DECIMAL(10,2) DEFAULT 0,
    goal_amount DECIMAL(10,2) DEFAULT 0,
    goal_description TEXT DEFAULT '',
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Fixed costs table (custos fixos)
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

-- Enable Row Level Security (RLS)
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE balances ENABLE ROW LEVEL SECURITY;
ALTER TABLE savings ENABLE ROW LEVEL SECURITY;
ALTER TABLE fixed_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_cards ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist, then recreate
DROP POLICY IF EXISTS "Allow all for users" ON users;
DROP POLICY IF EXISTS "Allow all for expenses" ON expenses;
DROP POLICY IF EXISTS "Allow all for balances" ON balances;
DROP POLICY IF EXISTS "Allow all for savings" ON savings;
DROP POLICY IF EXISTS "Allow all for fixed_costs" ON fixed_costs;
DROP POLICY IF EXISTS "Allow all for credit_cards" ON credit_cards;

-- Allow all operations for anon key (since login is app-level)
CREATE POLICY "Allow all for users" ON users
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for expenses" ON expenses
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for balances" ON balances
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for savings" ON savings
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for fixed_costs" ON fixed_costs
    FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Allow all for credit_cards" ON credit_cards
    FOR ALL USING (true) WITH CHECK (true);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_expenses_user ON expenses(user_name);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_balances_user ON balances(user_name);
CREATE INDEX IF NOT EXISTS idx_savings_user ON savings(user_name);
CREATE INDEX IF NOT EXISTS idx_fixed_costs_user ON fixed_costs(user_name);
CREATE INDEX IF NOT EXISTS idx_credit_cards_user ON credit_cards(user_name);

-- Add new columns to existing expenses table (if upgrading)
-- Run these only if upgrading from old schema:
-- ALTER TABLE expenses ADD COLUMN IF NOT EXISTS payment_method TEXT DEFAULT 'debit';
-- ALTER TABLE expenses ADD COLUMN IF NOT EXISTS paid_by TEXT;
