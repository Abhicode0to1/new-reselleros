import fs from 'fs';
import path from 'path';

const envPath = path.join(process.cwd(), '.env.local');
if (fs.existsSync(envPath)) {
  const content = fs.readFileSync(envPath, 'utf8');
  console.log("=== ENV KEYS PRESENT ===");
  const lines = content.split('\n');
  for (const l of lines) {
    const key = l.split('=')[0]?.trim();
    if (key) console.log(key);
  }
}
