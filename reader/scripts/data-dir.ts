import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** The unzipped participant bundle: inbox/ + attachments/ + sample_submission.json */
export const DATA_DIR = (() => {
  if (process.env.SDOC_DATA_DIR) return resolve(process.env.SDOC_DATA_DIR);
  const candidates = [
    join(process.cwd(), '..', 'data', 'bundle'),
    join(process.cwd(), 'data', 'bundle'),
    join(process.cwd(), '..', '..', 'hackathon-full', 'data', 'bundle'),
  ];
  const found = candidates.find((c) => existsSync(join(c, 'inbox')));
  if (!found) {
    throw new Error(
      `dataset not found. Unzip sdoc-hackathon-bundle.zip and set SDOC_DATA_DIR, tried:\n  ${candidates.join('\n  ')}`,
    );
  }
  return resolve(found);
})();
