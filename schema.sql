-- ============================================================
-- BTG Davomat — PostgreSQL Schema
-- Run with: psql "$DATABASE_URL" -f schema.sql
-- Safe to re-run: uses IF NOT EXISTS / DO blocks where possible.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Department enum
--    Maps internal codes -> human-readable Uzbek names (handled in app code):
--    SOTUV          -> Sotuv
--    MARKETOLOG     -> Marketolog
--    LAZER          -> Lazer bo'limi
--    PAYVANDLASH    -> Payvandlash
--    YIGUV          -> Yig'uv
--    KRASKA_SEPISH  -> Kraska sepish
-- ------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'department_enum') THEN
        CREATE TYPE department_enum AS ENUM (
            'SOTUV', 'MARKETOLOG', 'LAZER', 'PAYVANDLASH', 'YIGUV', 'KRASKA_SEPISH'
        );
    END IF;
END$$;

-- ------------------------------------------------------------
-- 2. employees
--    One row per staff member. telegram_id links the Mini App /
--    Bot session to a specific employee & pay rate.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS employees (
    id                    SERIAL PRIMARY KEY,
    telegram_id           BIGINT UNIQUE NOT NULL,
    full_name             VARCHAR(100) NOT NULL,
    department            department_enum NOT NULL,
    hourly_rate           DECIMAL(12, 2) NOT NULL CHECK (hourly_rate >= 0),
    overtime_multiplier   DECIMAL(3, 2) DEFAULT 1.5 CHECK (overtime_multiplier >= 1),
    is_active             BOOLEAN NOT NULL DEFAULT TRUE, -- soft-disable instead of deleting
    created_at            TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- ------------------------------------------------------------
-- 3. attendance
--    One row per employee per calendar day.
--    A UNIQUE constraint on (employee_id, date) guarantees a single
--    check-in/out cycle per day and lets us use UPSERT semantics.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attendance (
    id                    SERIAL PRIMARY KEY,
    employee_id           INT NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    department            department_enum NOT NULL,
    date                  DATE DEFAULT CURRENT_DATE,

    check_in              TIMESTAMP,
    check_in_location     VARCHAR(100), -- "lat,lng" text, e.g. "41.311080,69.240561"
    check_in_accuracy_m   DECIMAL(6, 2), -- GPS accuracy reported by device, in meters
    late_reason           TEXT,          -- mandatory if check_in > WORK_START

    check_out             TIMESTAMP,
    check_out_location    VARCHAR(100),
    check_out_accuracy_m  DECIMAL(6, 2),
    overtime_reason       TEXT,          -- mandatory if check_out > WORK_END

    regular_hours         DECIMAL(5, 2) DEFAULT 0,
    overtime_hours        DECIMAL(5, 2) DEFAULT 0,
    daily_salary          DECIMAL(12, 2) DEFAULT 0,

    CONSTRAINT uq_employee_day UNIQUE (employee_id, date)
);

-- Helpful indexes for dashboard / monthly export queries
CREATE INDEX IF NOT EXISTS idx_attendance_employee_date ON attendance (employee_id, date);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (date);
CREATE INDEX IF NOT EXISTS idx_attendance_department ON attendance (department);
CREATE INDEX IF NOT EXISTS idx_employees_telegram_id ON employees (telegram_id);

-- ------------------------------------------------------------
-- 4. Seed data (OPTIONAL) — comment out / edit before running in production.
--    Replace telegram_id with real numeric Telegram user IDs
--    (get them from /start in the bot, or @userinfobot).
-- ------------------------------------------------------------
-- INSERT INTO employees (telegram_id, full_name, department, hourly_rate) VALUES
-- (111111111, 'Aliyev Vali',      'SOTUV',         25000),
-- (222222222, 'Karimova Nodira',  'MARKETOLOG',    22000),
-- (333333333, 'Tosh Botirov',     'LAZER',         30000),
-- (444444444, 'Sardorov Jasur',   'PAYVANDLASH',   28000),
-- (555555555, 'Yigitaliyev Anvar','YIGUV',         24000),
-- (666666666, 'Rustamov Doston',  'KRASKA_SEPISH', 23000)
-- ON CONFLICT (telegram_id) DO NOTHING;
