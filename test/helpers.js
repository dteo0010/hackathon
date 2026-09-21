// Shared fixtures for the tests.
import { DocType, FIELDS, makeDocument, makeEmailResult } from '../src/models.js';

export const SI_TEXT = `SHIPPING INSTRUCTION
Shipper: Acme Trading Sdn Bhd, Johor Bahru
Consignee: Blue Ocean Imports Ltd, Rotterdam
Notify Party: Same as consignee
Port of Loading: Port Klang
Port of Discharge: Rotterdam
Containers: 3 x 40HC   Gross Weight: 22,000 KGS`;

export const BL_TEXT = SI_TEXT.replace('SHIPPING INSTRUCTION', 'DRAFT BILL OF LADING').replace('Port of Loading', 'Load Port');

export const VALUES = {
  shipper: 'Acme Trading Sdn Bhd', consignee: 'Blue Ocean Imports Ltd', notify_party: 'Same as consignee',
  port_of_loading: 'Port Klang', port_of_discharge: 'Rotterdam', container_count: '3', gross_weight_kg: '22000',
};

export function doc(path, docType, { text, overrides = {}, ...rest } = {}) {
  const vals = { ...VALUES, ...overrides };
  const fields = Object.fromEntries(FIELDS.filter((f) => f in vals).map((f) => [f, { value: vals[f] }]));
  return makeDocument({ path, docType, text: text ?? (docType === DocType.SI ? SI_TEXT : BL_TEXT), fields, ...rest });
}

export const si = (opts) => doc('attachments/email_001_SI.pdf', DocType.SI, opts);
export const bl = (opts) => doc('attachments/email_001_BL.pdf', DocType.BL, opts);

export function email(docs, { attachments, category = 'BL_COMPARISON', ...rest } = {}) {
  return makeEmailResult({ emailId: 'email_001', category, attachments: attachments ?? docs.map((d) => d.path), documents: docs, ...rest });
}
