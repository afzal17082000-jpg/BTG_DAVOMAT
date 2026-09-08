// ============================================================
// src/services/attendanceService.js
// All check-in / check-out / reporting logic lives here so that
// BOTH the HTTP API (routes/api.js) and the Telegram bot (bot.js)
// call the exact same, single implementation — no duplicated rules.
// ============================================================
const db = require('../db');
const { validateGeofence } = require('../utils/geo');
const { calculateShift, isLateCheckIn, isOvertimeCheckOut } = require('../utils/salary');
const { labelFor } = require('../utils/departments');

class AttendanceError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code; // machine-readable code the frontend switches on
    this.extra = extra;
  }
}

/** Returns today's date in "YYYY-MM-DD" using the server's local time. */
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Fetch (or implicitly note the absence of) today's attendance row for an employee.
 */
async function getTodayRecord(employeeId) {
  const { rows } = await db.query(
    `SELECT * FROM attendance WHERE employee_id = $1 AND date = CURRENT_DATE LIMIT 1`,
    [employeeId]
  );
  return rows[0] || null;
}

/**
 * CHECK-IN
 * Flow:
 *   1. Reject if already checked in today.
 *   2. Validate GPS is inside the geofence (server-side, authoritative).
 *   3. If current time is after WORK_START, `lateReason` is REQUIRED.
 *      If it's missing, we throw AttendanceError('late_reason_required')
 *      so the API can tell the frontend to show the reason modal
 *      WITHOUT having written any row yet (keeps it retry-safe).
 *   4. Insert the attendance row.
 */
async function checkIn(employee, { lat, lng, accuracy, lateReason }) {
  const existing = await getTodayRecord(employee.id);
  if (existing && existing.check_in) {
    throw new AttendanceError('already_checked_in', "Siz bugun allaqachon kelgansiz.");
  }

  const geo = validateGeofence({ lat, lng, accuracy });
  if (!geo.ok) {
    throw new AttendanceError('geofence_failed', geofenceMessage(geo), geo);
  }

  const now = new Date();
  const late = isLateCheckIn(now);

  if (late && (!lateReason || !lateReason.trim())) {
    // Signal to the caller (route/bot) that a mandatory reason is still needed.
    throw new AttendanceError('late_reason_required', 'Kech qolganingiz uchun sabab kiriting.', { late: true });
  }

  const locationStr = `${lat.toFixed(6)},${lng.toFixed(6)}`;

  const { rows } = await db.query(
    `INSERT INTO attendance
        (employee_id, department, date, check_in, check_in_location, check_in_accuracy_m, late_reason)
     VALUES ($1, $2, CURRENT_DATE, $3, $4, $5, $6)
     ON CONFLICT (employee_id, date)
     DO UPDATE SET check_in = EXCLUDED.check_in,
                   check_in_location = EXCLUDED.check_in_location,
                   check_in_accuracy_m = EXCLUDED.check_in_accuracy_m,
                   late_reason = EXCLUDED.late_reason
     RETURNING *`,
    [employee.id, employee.department, now, locationStr, accuracy, late ? lateReason.trim() : null]
  );

  return { record: rows[0], late, distanceM: geo.distanceM };
}

/**
 * CHECK-OUT
 * Flow:
 *   1. Must have checked in today and not already checked out.
 *   2. Validate GPS is inside the geofence.
 *   3. If current time is after WORK_END, `overtimeReason` is REQUIRED.
 *   4. Compute regular/overtime hours + daily salary, then update the row.
 */
async function checkOut(employee, { lat, lng, accuracy, overtimeReason }) {
  const existing = await getTodayRecord(employee.id);
  if (!existing || !existing.check_in) {
    throw new AttendanceError('not_checked_in', "Siz bugun hali kelmagansiz.");
  }
  if (existing.check_out) {
    throw new AttendanceError('already_checked_out', "Siz bugun allaqachon ketgansiz.");
  }

  const geo = validateGeofence({ lat, lng, accuracy });
  if (!geo.ok) {
    throw new AttendanceError('geofence_failed', geofenceMessage(geo), geo);
  }

  const now = new Date();
  const overtime = isOvertimeCheckOut(now);

  if (overtime && (!overtimeReason || !overtimeReason.trim())) {
    throw new AttendanceError('overtime_reason_required', 'Qo\u2019shimcha ish vaqti uchun sabab kiriting.', {
      overtime: true,
    });
  }

  const shift = calculateShift(
    new Date(existing.check_in),
    now,
    Number(employee.hourly_rate),
    Number(employee.overtime_multiplier)
  );

  const locationStr = `${lat.toFixed(6)},${lng.toFixed(6)}`;

  const { rows } = await db.query(
    `UPDATE attendance
        SET check_out = $1,
            check_out_location = $2,
            check_out_accuracy_m = $3,
            overtime_reason = $4,
            regular_hours = $5,
            overtime_hours = $6,
            daily_salary = $7
      WHERE id = $8
      RETURNING *`,
    [
      now,
      locationStr,
      accuracy,
      overtime ? overtimeReason.trim() : null,
      shift.regularHours,
      shift.overtimeHours,
      shift.dailySalary,
      existing.id,
    ]
  );

  return { record: rows[0], overtime, distanceM: geo.distanceM, shift };
}

function geofenceMessage(geo) {
  switch (geo.reason) {
    case 'out_of_range':
      return `Siz korxona hududidan tashqaridasiz (masofa: ${geo.distanceM} m). Iltimos, korxona hududiga kiring.`;
    case 'low_accuracy':
      return `GPS aniqligi yetarli emas (\u00b1${Math.round(geo.accuracy)} m). Ochiq joyga chiqib qayta urinib ko\u2019ring.`;
    case 'missing_accuracy':
      return 'GPS ma\u02bblumotini olib bo\u2019lmadi. Joylashuvni yoqib qayta urinib ko\u2019ring.';
    default:
      return 'Joylashuvingizni tekshirib bo\u2019lmadi. Qayta urinib ko\u2019ring.';
  }
}

/**
 * Monthly stats + full attendance list for one employee (used by the
 * Mini App "My stats" tab and the /dashboard bot command).
 * @param {string} month - "YYYY-MM"
 */
async function getMonthlyStats(employeeId, month) {
  const { rows } = await db.query(
    `SELECT * FROM attendance
      WHERE employee_id = $1
        AND to_char(date, 'YYYY-MM') = $2
      ORDER BY date ASC`,
    [employeeId, month]
  );

  const totals = rows.reduce(
    (acc, r) => {
      acc.regularHours += Number(r.regular_hours || 0);
      acc.overtimeHours += Number(r.overtime_hours || 0);
      acc.salary += Number(r.daily_salary || 0);
      acc.daysWorked += r.check_in ? 1 : 0;
      acc.lateDays += r.late_reason ? 1 : 0;
      return acc;
    },
    { regularHours: 0, overtimeHours: 0, salary: 0, daysWorked: 0, lateDays: 0 }
  );

  return { month, records: rows, totals };
}

/**
 * Company-wide summary for a month, grouped by employee — used by the
 * admin dashboard and the Excel export.
 */
async function getAllEmployeesMonthlyReport(month) {
  const { rows } = await db.query(
    `SELECT e.id AS employee_id, e.full_name, e.department, e.hourly_rate,
            a.date, a.check_in, a.late_reason, a.check_out, a.overtime_reason,
            a.regular_hours, a.overtime_hours, a.daily_salary
       FROM employees e
       LEFT JOIN attendance a
              ON a.employee_id = e.id AND to_char(a.date, 'YYYY-MM') = $1
      WHERE e.is_active = TRUE
      ORDER BY e.department, e.full_name, a.date`,
    [month]
  );
  return rows;
}

module.exports = {
  AttendanceError,
  todayStr,
  getTodayRecord,
  checkIn,
  checkOut,
  getMonthlyStats,
  getAllEmployeesMonthlyReport,
  labelFor,
};
