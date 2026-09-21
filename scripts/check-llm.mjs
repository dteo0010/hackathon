/**
 * node scripts/check-llm.mjs
 * Checks the Gemini key end to end: loads .env, then asks C's extractor to read an
 * SI whose port-of-loading label ("Loading at") is not in the rule table, so the
 * LLM fallback has to find it. Also a handy live demo of where the AI steps in.
 */
import '../src/env.js';
import { PythonBridge } from '../src/stages.js';

if (!process.env.GEMINI_API_KEY) { console.log('GEMINI_API_KEY is not set (.env missing or empty).'); process.exit(1); }
const text = `SHIPPING INSTRUCTION
Shipper: APRIL FAR EAST (M) SDN BHD
Consignee: EAST BRIGHT FZ-LLC
Notify: EAST BRIGHT FZ-LLC
Loading at: PORT KLANG (WESTPORT), MALAYSIA
POD: KARACHI, PAKISTAN
Total Containers: 6 x 40'HC
Gross Weight: 131,058 KG
`;
const bridge = new PythonBridge();
try {
  const x = await bridge.call('extract', { text });
  const f = x.fields.port_of_loading;
  console.log('port_of_loading:', JSON.stringify({ value: f.value, decided_by: f.decided_by, evidence: f.evidence, confidence: f.confidence, reason: f.reason }));
  if (f.decided_by === 'llm' && f.value) console.log('OK: Gemini answered and the answer was grounded in the text.');
  else console.log('Gemini did not produce a usable answer. Check the key, `pip install google-genai` in the Python the bridge uses, and the model name (SDOC_LLM_MODEL).');
} finally {
  bridge.stop();
}
