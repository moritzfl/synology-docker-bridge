import fs from "node:fs";
import path from "node:path";

/** Minimal .env parser for compose files: KEY=VALUE, comments, single/double quotes. */
export function parse(text) {
  const values = {};
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const equals = trimmed.indexOf("=");
    if (equals <= 0) {
      continue;
    }
    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();
    if (value.length >= 2
        && ((value.startsWith('"') && value.endsWith('"'))
          || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function format(values) {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join("\n") + "\n";
}

function quote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+,-]*$/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function read(file) {
  try {
    return parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

export function write(file, values) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(temporary, format(values), { mode: 0o644 });
  fs.renameSync(temporary, file);
}
