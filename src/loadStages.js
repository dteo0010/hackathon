/**
 * Pick which classify / extract / compare the pipeline uses.
 *
 *   "demo"                 stand-ins for the 14-email demo inbox (src/reliability/demo.js)
 *   "baseline"             working stand-ins for the real dataset (src/baseline.js)
 *   "path/to/file.js#name" the team's own module; `name` is a function (source) -> stages
 *
 * '#' separates file and export because Windows paths contain ':'.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export function defaultStagesFor(dataSource) {
  return dataSource === 'demo_data' ? 'demo' : 'baseline';
}

export async function loadStages(spec, source) {
  if (spec === 'demo') return (await import('./reliability/demo.js')).stagesFor(source);
  if (spec === 'baseline') return (await import('./baseline.js')).stagesFor(source);
  const [file, name = 'stagesFor'] = spec.split('#');
  const mod = await import(pathToFileURL(path.resolve(file)).href);
  if (typeof mod[name] !== 'function') throw new Error(`${file} has no exported function "${name}"`);
  return mod[name](source);
}
