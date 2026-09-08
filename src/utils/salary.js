// ============================================================
// src/utils/salary.js
// Pure functions implementing the company's pay rules:
//   1. Time worked before the official WORK_START is unpaid
//      (i.e. arriving early doesn't earn extra pay).
//   2. Time worked between check-in and WORK_END (capped) is
//      "regular hours", paid at hourly_rate.
//   3. Time worked after WORK_END is "overtime hours", paid at
//      hourly_rate * overtime_multiplier (default 1.5x).
//   4. A late check-in (after WORK_START) makes the gap between
//      WORK_START and check-in unpaid — it is simply not counted,
//      not a penalty beyond that.
// No I/O here — fully unit-testable pure functions.
// ============================================================
const config = require('../config');

/**
 * Combine a DATE and "HH:MM" into a real Date object in local server time.
 * We rely on the server/DB running in a consistent timezone (see .env TIMEZONE
 * and deployment notes in README) so plain Date math is correct.
 */
function dateWithTime(baseDate, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const d = new Date(baseDate);
  d.setHours(h, m, 0, 0);
  return d;
}

const MS_PER_HOUR = 1000 * 60 * 60;

/**
 * @param {Date} checkIn
 * @param {Date} checkOut
 * @param {number} hourlyRate
 * @param {number} overtimeMultiplier
 * @returns {{ regularHours: number, overtimeHours: number, dailySalary: number, isLate: boolean, isOvertime: boolean }}
 */
function calculateShift(checkIn, checkOut, hourlyRate, overtimeMultiplier) {
  if (!(checkIn instanceof Date) || !(checkOut instanceof Date)) {
    throw new Error('calculateShift requires Date objects for checkIn and checkOut');
  }
  if (checkOut <= checkIn) {
    throw new Error('checkOut must be after checkIn');
  }

  const workStart = dateWithTime(checkIn, config.workSchedule.startStr);
  const workEnd = dateWithTime(checkIn, config.workSchedule.endStr);

  const isLate = checkIn > workStart;
  const isOvertime = checkOut > workEnd;

  // Regular-hours window: from the LATER of (checkIn, workStart) to the
  // EARLIER of (checkOut, workEnd). Early arrival before workStart doesn't
  // count; work continuing past workEnd is handled separately as overtime.
  const regularStart = checkIn > workStart ? checkIn : workStart;
  const regularEnd = checkOut < workEnd ? checkOut : workEnd;
  const regularMs = Math.max(0, regularEnd - regularStart);
  const regularHours = round2(regularMs / MS_PER_HOUR);

  // Overtime window: anything worked after workEnd.
  const overtimeMs = checkOut > workEnd ? checkOut - workEnd : 0;
  const overtimeHours = round2(overtimeMs / MS_PER_HOUR);

  const dailySalary = round2(
    regularHours * hourlyRate + overtimeHours * hourlyRate * overtimeMultiplier
  );

  return { regularHours, overtimeHours, dailySalary, isLate, isOvertime, workStart, workEnd };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Determines, from a raw check-in timestamp alone, whether it counts as late
 * (used by the API right after check-in, before checkout/salary exist yet).
 */
function isLateCheckIn(checkInDate) {
  const workStart = dateWithTime(checkInDate, config.workSchedule.startStr);
  return checkInDate > workStart;
}

/**
 * Determines, from a raw check-out timestamp alone, whether it counts as overtime.
 */
function isOvertimeCheckOut(checkOutDate) {
  const workEnd = dateWithTime(checkOutDate, config.workSchedule.endStr);
  return checkOutDate > workEnd;
}

module.exports = { calculateShift, isLateCheckIn, isOvertimeCheckOut, dateWithTime, round2 };
