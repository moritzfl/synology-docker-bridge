import { readPrivateFile, writePrivateFile } from "./private-file.mjs";

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
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

export function format(values) {
  return (
    Object.entries(values)
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join("\n") + "\n"
  );
}

function quote(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_./:@%+,-]*$/.test(text)) {
    return text;
  }
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function read(file, owner) {
  try {
    return parse(readPrivateFile(file, owner));
  } catch (error) {
    // A missing file, and a symlink planted where the file belongs, both start from no values.
    if (["ENOENT", "ELOOP", "ENOTDIR"].includes(error.code)) {
      return {};
    }
    throw error;
  }
}

export function write(file, values, owner = null) {
  writePrivateFile(file, format(values), { mode: 0o600, owner });
}
