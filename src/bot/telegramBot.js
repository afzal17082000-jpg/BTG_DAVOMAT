// ============================================================
// src/bot/telegramBot.js
// Builds and returns a fully-configured Telegraf bot instance —
// all commands, all handlers — WITHOUT starting it (no .launch(),
// no webhook setup). That part is the caller's job:
//   - bot.js        -> calls bot.launch() for long-polling (BOT_MODE=polling)
//   - server.js     -> mounts bot.createWebhook(...) for webhook mode (BOT_MODE=webhook)
// Keeping the commands in one place means both delivery modes are
// guaranteed to behave identically — no duplicated logic to drift apart.
// ============================================================
const { Telegraf, Markup } = require('telegraf');
const config = require('../config');
const db = require('../db');
const attendanceService = require('../services/attendanceService');
const { buildAttendanceWorkbook } = require('../services/excelExport');
const { DEPARTMENTS, labelFor, isValidCode } = require('../utils/departments');

function createBot() {
  const bot = new Telegraf(config.botToken);

  // --------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------
  function isAdmin(ctx) {
    return config.adminTelegramIds.includes(ctx.from.id);
  }

  function currentMonthStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  async function getEmployeeByTelegramId(telegramId) {
    const { rows } = await db.query(
      `SELECT * FROM employees WHERE telegram_id = $1 AND is_active = TRUE LIMIT 1`,
      [telegramId]
    );
    return rows[0] || null;
  }

  function fmtHours(h) {
    return `${Number(h).toFixed(2)} soat`;
  }
  function fmtMoney(n) {
    return `${Number(n).toLocaleString('ru-RU')} so'm`;
  }

  // --------------------------------------------------------------
  // /start — greet the user and open the Mini App
  // --------------------------------------------------------------
  bot.start(async (ctx) => {
    const employee = await getEmployeeByTelegramId(ctx.from.id);

    const greeting = employee
      ? `Assalomu alaykum, *${employee.full_name}*!\nBo'lim: ${labelFor(employee.department)}\n\nDavomatni belgilash uchun quyidagi tugmani bosing.`
      : `Assalomu alaykum!\n\n⚠️ Siz hozircha tizimda ro'yxatdan o'tmagansiz. Administratorga murojaat qiling — u sizni telegram ID: \`${ctx.from.id}\` orqali qo'shadi.`;

    const buttons = [];
    if (employee && config.webAppUrl) {
      buttons.push([Markup.button.webApp('📍 Davomatni belgilash', config.webAppUrl)]);
    }
    if (employee) {
      buttons.push([Markup.button.callback('📊 Mening statistikam', 'dashboard')]);
    }

    await ctx.replyWithMarkdown(greeting, buttons.length ? Markup.inlineKeyboard(buttons) : undefined);
  });

  // --------------------------------------------------------------
  // /dashboard and the matching inline button — personal monthly summary
  // --------------------------------------------------------------
  async function sendDashboard(ctx) {
    const employee = await getEmployeeByTelegramId(ctx.from.id);
    if (!employee) {
      return ctx.reply("Siz tizimda ro'yxatdan o'tmagansiz.");
    }

    const month = currentMonthStr();
    const { totals } = await attendanceService.getMonthlyStats(employee.id, month);

    const text =
      `📊 *${month} oyi bo'yicha statistika*\n\n` +
      `👤 ${employee.full_name} (${labelFor(employee.department)})\n\n` +
      `✅ Ishlagan kunlar: ${totals.daysWorked}\n` +
      `⏰ Kech qolgan kunlar: ${totals.lateDays}\n` +
      `🕒 Oddiy soatlar: ${fmtHours(totals.regularHours)}\n` +
      `➕ Qo'shimcha soatlar: ${fmtHours(totals.overtimeHours)}\n` +
      `💰 Jami maosh: *${fmtMoney(totals.salary)}*`;

    await ctx.replyWithMarkdown(text);
  }
  bot.command('dashboard', sendDashboard);
  bot.action('dashboard', async (ctx) => {
    await ctx.answerCbQuery();
    await sendDashboard(ctx);
  });

  // --------------------------------------------------------------
  // /export_excel [YYYY-MM] — send an .xlsx report
  // Regular employees get their own data; admins get everyone's.
  // --------------------------------------------------------------
  bot.command('export_excel', async (ctx) => {
    const employee = await getEmployeeByTelegramId(ctx.from.id);
    if (!employee) {
      return ctx.reply("Siz tizimda ro'yxatdan o'tmagansiz.");
    }

    const arg = ctx.message.text.split(' ')[1];
    const month = /^\d{4}-\d{2}$/.test(arg || '') ? arg : currentMonthStr();

    await ctx.reply(`⏳ ${month} oyi uchun hisobot tayyorlanmoqda...`);

    let rows;
    let filename;
    if (isAdmin(ctx)) {
      rows = await attendanceService.getAllEmployeesMonthlyReport(month);
      filename = `BTG_Davomat_${month}.xlsx`;
    } else {
      const { records } = await attendanceService.getMonthlyStats(employee.id, month);
      rows = records.map((r) => ({
        full_name: employee.full_name,
        department: employee.department,
        date: r.date,
        check_in: r.check_in,
        late_reason: r.late_reason,
        check_out: r.check_out,
        overtime_reason: r.overtime_reason,
        regular_hours: r.regular_hours,
        overtime_hours: r.overtime_hours,
        daily_salary: r.daily_salary,
      }));
      filename = `Davomat_${employee.full_name.replace(/\s+/g, '_')}_${month}.xlsx`;
    }

    if (rows.filter((r) => r.date).length === 0) {
      return ctx.reply(`${month} oyi uchun ma'lumot topilmadi.`);
    }

    const buffer = await buildAttendanceWorkbook(rows, month);
    await ctx.replyWithDocument({ source: Buffer.from(buffer), filename });
  });

  // --------------------------------------------------------------
  // /admin_dashboard [YYYY-MM] — company-wide summary (admins only)
  // --------------------------------------------------------------
  bot.command('admin_dashboard', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Bu buyruq faqat administratorlar uchun.");

    const arg = ctx.message.text.split(' ')[1];
    const month = /^\d{4}-\d{2}$/.test(arg || '') ? arg : currentMonthStr();
    const rows = await attendanceService.getAllEmployeesMonthlyReport(month);

    const byDept = {};
    for (const d of DEPARTMENTS) byDept[d.code] = { label: d.label, salary: 0, hours: 0, employees: new Set() };

    for (const r of rows) {
      byDept[r.department].employees.add(r.employee_id);
      if (r.date) {
        byDept[r.department].salary += Number(r.daily_salary || 0);
        byDept[r.department].hours += Number(r.regular_hours || 0) + Number(r.overtime_hours || 0);
      }
    }

    let text = `🏢 *BTG — ${month} oyi bo'yicha umumiy hisobot*\n\n`;
    let grandTotal = 0;
    for (const code of Object.keys(byDept)) {
      const d = byDept[code];
      grandTotal += d.salary;
      text += `*${d.label}*: ${d.employees.size} xodim, ${fmtHours(d.hours)}, ${fmtMoney(d.salary)}\n`;
    }
    text += `\n💰 *Jami maosh fondi:* ${fmtMoney(grandTotal)}`;

    await ctx.replyWithMarkdown(text);
  });

  // --------------------------------------------------------------
  // /add_employee <telegram_id> <full_name> <department_code> <hourly_rate>
  // Admin-only staff onboarding. Example:
  //   /add_employee 123456789 "Aliyev Vali" SOTUV 25000
  // --------------------------------------------------------------
  bot.command('add_employee', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Bu buyruq faqat administratorlar uchun.");

    const argsMatch = ctx.message.text.match(/"[^"]+"|\S+/g) || [];
    const [, telegramIdRaw, fullNameRaw, deptRaw, rateRaw] = argsMatch;

    if (!telegramIdRaw || !fullNameRaw || !deptRaw || !rateRaw) {
      return ctx.replyWithMarkdown(
        'Foydalanish: `/add_employee <telegram_id> "<F.I.O.>" <BO\'LIM_KODI> <soatlik_stavka>`\n\n' +
          'Bo\'lim kodlari: ' +
          DEPARTMENTS.map((d) => `\`${d.code}\``).join(', ')
      );
    }

    const telegramId = Number(telegramIdRaw);
    const fullName = fullNameRaw.replace(/"/g, '');
    const department = deptRaw.toUpperCase();
    const rate = Number(rateRaw);

    if (!Number.isFinite(telegramId)) return ctx.reply("telegram_id noto'g'ri.");
    if (!isValidCode(department)) return ctx.reply("Bo'lim kodi noto'g'ri.");
    if (!Number.isFinite(rate) || rate <= 0) return ctx.reply("Soatlik stavka noto'g'ri.");

    await db.query(
      `INSERT INTO employees (telegram_id, full_name, department, hourly_rate)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id)
       DO UPDATE SET full_name = EXCLUDED.full_name,
                     department = EXCLUDED.department,
                     hourly_rate = EXCLUDED.hourly_rate,
                     is_active = TRUE`,
      [telegramId, fullName, department, rate]
    );

    await ctx.reply(`✅ ${fullName} (${labelFor(department)}) tizimga qo'shildi.`);
  });

  // --------------------------------------------------------------
  // /list_employees — admin-only roster
  // --------------------------------------------------------------
  bot.command('list_employees', async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Bu buyruq faqat administratorlar uchun.");

    const { rows } = await db.query(
      `SELECT full_name, department, hourly_rate, telegram_id FROM employees WHERE is_active = TRUE ORDER BY department, full_name`
    );
    if (rows.length === 0) return ctx.reply('Xodimlar topilmadi.');

    const text = rows
      .map((e) => `• ${e.full_name} — ${labelFor(e.department)} — ${fmtMoney(e.hourly_rate)}/soat — id:${e.telegram_id}`)
      .join('\n');

    await ctx.reply(text);
  });

  // --------------------------------------------------------------
  // /help
  // --------------------------------------------------------------
  bot.help((ctx) => {
    const lines = [
      '*BTG Davomat — buyruqlar*',
      '/start — Mini App orqali davomat belgilash',
      '/dashboard — shu oy bo\'yicha statistikangiz',
      '/export_excel [YYYY-MM] — Excel hisobotni yuklab olish',
    ];
    if (isAdmin(ctx)) {
      lines.push(
        '',
        '*Administrator buyruqlari:*',
        '/admin_dashboard [YYYY-MM] — kompaniya bo\'yicha umumiy hisobot',
        '/add_employee <id> "<F.I.O.>" <BO\'LIM> <stavka> — xodim qo\'shish',
        '/list_employees — xodimlar ro\'yxati'
      );
    }
    ctx.replyWithMarkdown(lines.join('\n'));
  });

  // --------------------------------------------------------------
  // Global error handler so one bad update doesn't crash the process
  // --------------------------------------------------------------
  bot.catch((err, ctx) => {
    console.error(`[bot] Error while handling update ${ctx.update.update_id}:`, err);
    ctx.reply('Kechirasiz, xatolik yuz berdi. Birozdan so\'ng qayta urinib ko\'ring.').catch(() => {});
  });

  return bot;
}

module.exports = { createBot };
