#!/usr/bin/env node
import { readFileSync } from 'node:fs';
const { password } = JSON.parse(readFileSync(new URL('./.auth/credentials.json', import.meta.url), 'utf8'));
process.stdout.write(password + '\n');
