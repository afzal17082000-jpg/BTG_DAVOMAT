// ============================================================
// src/routes/api.js
// All HTTP endpoints consumed by the Mini App (public/index.html).
// Every route (except /health) requires a valid Telegram session,
// enforced by requireTelegramAuth middleware.
// ============================================================
const express = require('express');
const { requireTelegramAuth } = require('../middleware/telegramAuth');
const attendanceService = require('../services/attendanceService');
const { buildAttendanceWorkbook } = require('../services/excelExport');
const { DEPARTMENTS, labelFor } = require('../utils/departments');
const config = require('../config');

const router = express.Router();

// --------------------------------------------------------------
// GET /api/health — simple uptime probe, no auth required
// --------------------------------------------------------------
router.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// All routes below require a verified Telegram Mini App session.
router.use(requireTelegramAuth);

// --------------------------------------------------------------
// GET /api/me — current employee profile + today's attendance status
// --------------------------------------------------------------
router.get('/me', async (req, res, next) => {
  try {
    const today = await attendanceService.getTodayRecord(req.employee.id);
    res.json({
      employee: {
        id: req.employee.id,
        fullName: req.employee.full_name,
        department: req.employee.department,
        departmentLabel: labelFor(req.employee.department),
        hourlyRate: Number(req.employee.hourly_rate),
        overtimeMultiplier: Number(req.employee.overtime_multiplier),
      },
      isAdmin: req.isAdmin,
      today: today
        ? {
            checkIn: today.check_in,
            lateReason: today.late_reason,
            checkOut: today.check_out,
            overtimeReason: today.overtime_reason,
            regularHours: Number(today.regular_hours),
            overtimeHours: Number(today.overtime_hours),
            dailySalary: Number(today.daily_salary),
          }
        : null,
      geofence: {
        // Sent to the client so the Mini App can show a live distance readout.
        lat: config.geofence.lat,
        lng: config.geofence.lng,
        radiusM: config.geofence.radiusM,
        maxAccuracyM: config.geofence.maxAccuracyM,
      },
      workSchedule: {
        start: config.workSchedule.startStr,
        end: config.workSchedule.endStr,
      },
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------
// POST /api/checkin
// Body: { lat, lng, accuracy, lateReason? }
// If the server determines the check-in is late and no lateReason was
// sent, it responds 409 with { error: "late_reason_required" } so the
// Mini App can pop the mandatory-reason modal and resubmit.
// --------------------------------------------------------------
router.post('/checkin', async (req, res, next) => {
  try {
    const { lat, lng, accuracy, lateReason } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'invalid_body', message: 'lat/lng required as numbers' });
    }

    const result = await attendanceService.checkIn(req.employee, { lat, lng, accuracy, lateReason });
    res.json({
      ok: true,
      late: result.late,
      distanceM: result.distanceM,
      checkIn: result.record.check_in,
    });
  } catch (err) {
    handleAttendanceError(err, res, next);
  }
});

// --------------------------------------------------------------
// POST /api/checkout
// Body: { lat, lng, accuracy, overtimeReason? }
// Mirrors /checkin: 409 + "overtime_reason_required" if needed.
// --------------------------------------------------------------
router.post('/checkout', async (req, res, next) => {
  try {
    const { lat, lng, accuracy, overtimeReason } = req.body || {};
    if (typeof lat !== 'number' || typeof lng !== 'number') {
      return res.status(400).json({ error: 'invalid_body', message: 'lat/lng required as numbers' });
    }

    const result = await attendanceService.checkOut(req.employee, { lat, lng, accuracy, overtimeReason });
    res.json({
      ok: true,
      overtime: result.overtime,
      distanceM: result.distanceM,
      checkOut: result.record.check_out,
      regularHours: Number(result.record.regular_hours),
      overtimeHours: Number(result.record.overtime_hours),
      dailySalary: Number(result.record.daily_salary),
    });
  } catch (err) {
    handleAttendanceError(err, res, next);
  }
});

// --------------------------------------------------------------
// GET /api/dashboard?month=YYYY-MM — personal monthly stats
// --------------------------------------------------------------
router.get('/dashboard', async (req, res, next) => {
  try {
    const month = req.query.month || currentMonthStr();
    const data = await attendanceService.getMonthlyStats(req.employee.id, month);
    res.json({
      month,
      totals: data.totals,
      records: data.records.map((r) => ({
        date: r.date,
        checkIn: r.check_in,
        lateReason: r.late_reason,
        checkOut: r.check_out,
        overtimeReason: r.overtime_reason,
        regularHours: Number(r.regular_hours),
        overtimeHours: Number(r.overtime_hours),
        dailySalary: Number(r.daily_salary),
      })),
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------
// GET /api/admin/dashboard?month=YYYY-MM — company-wide summary (admins only)
// --------------------------------------------------------------
router.get('/admin/dashboard', async (req, res, next) => {
  try {
    if (!req.isAdmin) return res.status(403).json({ error: 'forbidden' });

    const month = req.query.month || currentMonthStr();
    const rows = await attendanceService.getAllEmployeesMonthlyReport(month);

    // Group by department for a compact summary view.
    const byDept = {};
    for (const d of DEPARTMENTS) byDept[d.code] = { label: d.label, employees: 0, salary: 0, hours: 0 };

    const byEmployee = new Map();
    for (const r of rows) {
      if (!byEmployee.has(r.employee_id)) {
        byEmployee.set(r.employee_id, {
          employeeId: r.employee_id,
          fullName: r.full_name,
          department: r.department,
          totalRegularHours: 0,
          totalOvertimeHours: 0,
          totalSalary: 0,
          daysWorked: 0,
        });
      }
      const e = byEmployee.get(r.employee_id);
      if (r.date) {
        e.totalRegularHours += Number(r.regular_hours || 0);
        e.totalOvertimeHours += Number(r.overtime_hours || 0);
        e.totalSalary += Number(r.daily_salary || 0);
        e.daysWorked += r.check_in ? 1 : 0;
      }
    }

    for (const e of byEmployee.values()) {
      byDept[e.department].employees += 1;
      byDept[e.department].salary += e.totalSalary;
      byDept[e.department].hours += e.totalRegularHours + e.totalOvertimeHours;
    }

    res.json({
      month,
      departments: byDept,
      employees: [...byEmployee.values()],
    });
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------
// GET /api/export-excel?month=YYYY-MM
// Regular employees receive only their own data.
// Admins receive company-wide data.
// --------------------------------------------------------------
router.get('/export-excel', async (req, res, next) => {
  try {
    const month = req.query.month || currentMonthStr();

    let rows;
    let filename;
    if (req.isAdmin) {
      rows = await attendanceService.getAllEmployeesMonthlyReport(month);
      filename = `BTG_Davomat_${month}.xlsx`;
    } else {
      const data = await attendanceService.getMonthlyStats(req.employee.id, month);
      rows = data.records.map((r) => ({
        full_name: req.employee.full_name,
        department: req.employee.department,
        date: r.date,
        check_in: r.check_in,
        late_reason: r.late_reason,
        check_out: r.check_out,
        overtime_reason: r.overtime_reason,
        regular_hours: r.regular_hours,
        overtime_hours: r.overtime_hours,
        daily_salary: r.daily_salary,
      }));
      filename = `Davomat_${req.employee.full_name.replace(/\s+/g, '_')}_${month}.xlsx`;
    }

    const buffer = await buildAttendanceWorkbook(rows, month);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buffer));
  } catch (err) {
    next(err);
  }
});

// --------------------------------------------------------------
// Helpers
// --------------------------------------------------------------
function currentMonthStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function handleAttendanceError(err, res, next) {
  if (err && err.code) {
    // Known, expected business-rule errors -> 409 Conflict with a machine-readable code.
    return res.status(409).json({ error: err.code, message: err.message, ...err.extra });
  }
  next(err);
}

module.exports = router;
