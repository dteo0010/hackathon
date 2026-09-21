/**
 * Load the project's .env file (if there is one) into process.env, so API keys
 * never have to be typed into the terminal or committed. Variables already set
 * in the environment win over the file. Imported first by cli.js and server.js;
 * the Python bridge inherits the same environment.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
if (existsSync(file) && typeof process.loadEnvFile === 'function') process.loadEnvFile(file);
