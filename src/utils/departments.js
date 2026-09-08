// ============================================================
// src/utils/departments.js
// Single source of truth mapping DB enum codes <-> human labels.
// ============================================================

const DEPARTMENTS = [
  { code: 'SOTUV', label: "Sotuv" },
  { code: 'MARKETOLOG', label: 'Marketolog' },
  { code: 'LAZER', label: "Lazer bo'limi" },
  { code: 'PAYVANDLASH', label: 'Payvandlash' },
  { code: 'YIGUV', label: "Yig'uv" },
  { code: 'KRASKA_SEPISH', label: 'Kraska sepish' },
];

const CODE_TO_LABEL = Object.fromEntries(DEPARTMENTS.map((d) => [d.code, d.label]));
const LABEL_TO_CODE = Object.fromEntries(DEPARTMENTS.map((d) => [d.label.toLowerCase(), d.code]));

function labelFor(code) {
  return CODE_TO_LABEL[code] || code;
}

function isValidCode(code) {
  return Object.prototype.hasOwnProperty.call(CODE_TO_LABEL, code);
}

module.exports = { DEPARTMENTS, CODE_TO_LABEL, LABEL_TO_CODE, labelFor, isValidCode };
