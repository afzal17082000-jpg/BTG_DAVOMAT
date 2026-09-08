// ============================================================
// src/services/excelExport.js
// Builds a formatted .xlsx workbook (company-wide or personal)
// using exceljs. Returns a Buffer so callers can either send it
// as an HTTP response or as a Telegram document, unchanged.
// ============================================================
const ExcelJS = require('exceljs');
const { labelFor } = require('../utils/departments');

const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F2937' } };
const HEADER_FONT = { color: { argb: 'FFFFFFFF' }, bold: true };
const TOTAL_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE5E7EB' } };

/**
 * @param {Array} rows - rows from getAllEmployeesMonthlyReport() OR a single
 *                        employee's rows from getMonthlyStats().records
 * @param {string} month - "YYYY-MM", used in the title/header
 * @param {object} [opts] - { title }
 * @returns {Promise<Buffer>}
 */
async function buildAttendanceWorkbook(rows, month, opts = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'BTG Davomat';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(opts.title || `Davomat ${month}`, {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze header row
  });

  sheet.columns = [
    { header: 'F.I.O.', key: 'full_name', width: 24 },
    { header: "Bo'lim", key: 'department', width: 16 },
    { header: 'Sana', key: 'date', width: 12 },
    { header: 'Kelgan vaqt', key: 'check_in', width: 12 },
    { header: 'Kech qolish sababi', key: 'late_reason', width: 26 },
    { header: 'Ketgan vaqt', key: 'check_out', width: 12 },
    { header: "Qo'shimcha ish sababi", key: 'overtime_reason', width: 26 },
    { header: 'Oddiy soat', key: 'regular_hours', width: 12 },
    { header: "Qo'shimcha soat", key: 'overtime_hours', width: 15 },
    { header: 'Kunlik maosh', key: 'daily_salary', width: 14 },
  ];

  // Style header row
  const headerRow = sheet.getRow(1);
  headerRow.eachCell((cell) => {
    cell.fill = HEADER_FILL;
    cell.font = HEADER_FONT;
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });

  let totalRegular = 0;
  let totalOvertime = 0;
  let totalSalary = 0;

  for (const r of rows) {
    // Rows with no attendance at all for the month still show the employee
    // once (LEFT JOIN produces a row with null date) — skip pure "no data" rows
    // for company-wide reports so the sheet isn't cluttered, but keep them for
    // clarity when explicitly requested; here we simply render what's given.
    if (!r.date) continue;

    sheet.addRow({
      full_name: r.full_name,
      department: labelFor(r.department),
      date: formatDate(r.date),
      check_in: formatTime(r.check_in),
      late_reason: r.late_reason || '',
      check_out: formatTime(r.check_out),
      overtime_reason: r.overtime_reason || '',
      regular_hours: Number(r.regular_hours || 0),
      overtime_hours: Number(r.overtime_hours || 0),
      daily_salary: Number(r.daily_salary || 0),
    });

    totalRegular += Number(r.regular_hours || 0);
    totalOvertime += Number(r.overtime_hours || 0);
    totalSalary += Number(r.daily_salary || 0);
  }

  // Totals row
  const totalRow = sheet.addRow({
    full_name: 'JAMI',
    regular_hours: round2(totalRegular),
    overtime_hours: round2(totalOvertime),
    daily_salary: round2(totalSalary),
  });
  totalRow.eachCell((cell) => {
    cell.fill = TOTAL_FILL;
    cell.font = { bold: true };
  });

  // Number formatting for numeric columns
  sheet.getColumn('regular_hours').numFmt = '0.00';
  sheet.getColumn('overtime_hours').numFmt = '0.00';
  sheet.getColumn('daily_salary').numFmt = '#,##0.00';

  const buffer = await workbook.xlsx.writeBuffer();
  return buffer;
}

function formatDate(d) {
  const date = new Date(d);
  return date.toISOString().slice(0, 10);
}

function formatTime(d) {
  if (!d) return '';
  const date = new Date(d);
  return date.toTimeString().slice(0, 5);
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

module.exports = { buildAttendanceWorkbook };
